import { open, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { TextDecoder } from 'node:util';
import { redactTokens } from '../runners/gh-identity.js';
import {
  AGENT_ACTIVITY_EVENT_KEY,
  AGENT_OUTPUT_STREAM_KEY,
  type AgentActivitySnapshot,
  type AgentActivityStatus,
  AgentObservabilityError,
  type AgentAttemptSummary,
  type AgentLogChunk,
  type AgentLogMeta,
  type AgentLogStream,
  type AgentOutputEvent,
  type AgentRunActivity,
  type ReadAgentOutputEventsInput,
  type ReadAgentOutputEventsResult,
  type WatchAgentOutputInput,
} from './types.js';

export type AgentObservabilityServiceOptions = {
  artifactRoot: string;
  runExists?: (runId: string) => Promise<boolean> | boolean;
  dbos?: AgentObservabilityDbos;
  idleThresholdMs?: number;
  now?: () => number;
};

export type AgentObservabilityDbos = {
  getEvent<T>(workflowID: string, key: string, opts?: { timeoutSeconds?: number }): Promise<T | null>;
  readStream<T>(workflowID: string, key: string): AsyncGenerator<T, void, unknown>;
};

export type GetAgentLogInput = {
  runId: string;
  attemptId?: string;
  stream: AgentLogStream;
  offsetBytes?: number;
  limitBytes?: number;
  tailBytes?: number;
};

const DEFAULT_READ_BYTES = 65_536;
const MAX_READ_BYTES = 1_048_576;
const MAX_METADATA_BYTES = 65_536;
const SAFE_SEGMENT_RE = /^[A-Za-z0-9_.:-]+$/;
const LOG_FILES: Record<Exclude<AgentLogStream, 'combined'>, string> = {
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  events: 'events.jsonl',
};
const STDOUT_MARKER = '--- stdout ---\n';
const STDERR_MARKER = '\n--- stderr ---\n';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const UTF8_BOUNDARY_CONTEXT_BYTES = 3;
const SENSITIVE_BOUNDARY_SCAN_BYTES = 65_536;
const TOKEN_PATTERN = /\b(?:gh[opsru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s'"`]+/g;
const POSIX_PATH_PATTERN = /\/(?:Users|private|tmp|var|opt|home|workspace|Volumes)\/[^\s'"`)]+/g;
const DEFAULT_STREAM_EVENT_LIMIT = 100;
const MAX_STREAM_EVENT_LIMIT = 1_000;
const DEFAULT_STREAM_READ_TIMEOUT_MS = 250;
const DEFAULT_IDLE_THRESHOLD_MS = 120_000;
const MAX_STREAM_ACTIVITY_SCAN_EVENTS = 10_000;
const SAFE_CURSOR_RE = /^[A-Za-z0-9_.:-]+$/;

type ReadBounds =
  | { mode: 'tail'; tailBytes: number }
  | { mode: 'offset'; offsetBytes: number; limitBytes: number };

type AttemptCandidate = AgentAttemptSummary & {
  latestSortAt?: number;
  startedSortAt?: number;
};

type ExistingRunDirectory =
  | { exists: true; path: string; realRoot: string }
  | { exists: false; realRoot?: string };

type FileInfo =
  | { exists: true; path: string; size: number }
  | { exists: false; size: 0 };

type SyntheticSegment =
  | { kind: 'buffer'; buffer: Buffer; size: number }
  | { kind: 'file'; file: FileInfo; size: number };

type SensitiveSpan = {
  start: number;
  end: number;
  replacement: string;
};

type AlignedWindow = {
  buffer: Buffer;
  absoluteStart: number;
};

export class AgentObservabilityService {
  private readonly artifactRoot: string;
  private readonly runExists?: (runId: string) => Promise<boolean> | boolean;
  private readonly dbos?: AgentObservabilityDbos;
  private readonly idleThresholdMs: number;
  private readonly now: () => number;

  constructor(options: AgentObservabilityServiceOptions) {
    this.artifactRoot = resolve(options.artifactRoot);
    this.runExists = options.runExists;
    this.dbos = options.dbos;
    this.idleThresholdMs = validateIdleThreshold(options.idleThresholdMs);
    this.now = options.now ?? (() => Date.now());
  }

  async getAgentActivity(runId: string): Promise<AgentRunActivity | null> {
    const safeRunId = validateSegment(runId, 'runId');
    await this.assertRunExists(safeRunId);
    const eventSnapshot = await this.dbos?.getEvent<AgentRunActivity>(
      safeRunId,
      AGENT_ACTIVITY_EVENT_KEY,
      { timeoutSeconds: 0 },
    );
    if (eventSnapshot) return this.classifyActivity(eventSnapshot);

    const streamActivity = await this.readLatestAgentActivityFromStream(safeRunId);
    if (streamActivity) return streamActivity;

    return this.getAgentActivityFromArtifacts(safeRunId);
  }

  async readAgentOutputEvents(
    input: ReadAgentOutputEventsInput,
  ): Promise<ReadAgentOutputEventsResult> {
    const safeRunId = validateSegment(input.runId, 'runId');
    const cursor = input.cursor === undefined ? undefined : validateCursor(input.cursor);
    const limit = validateEventLimit(input.limit);
    const timeoutMs = validateStreamTimeout(input.timeoutMs);
    if (!this.dbos) {
      return { runId: safeRunId, events: [], cursorExpired: cursor !== undefined };
    }

    const generator = this.dbos.readStream<AgentOutputEvent>(safeRunId, AGENT_OUTPUT_STREAM_KEY);
    try {
      const page = await readBoundedOutputEvents({
        generator,
        runId: safeRunId,
        cursor,
        limit,
        timeoutMs,
      });
      return {
        runId: safeRunId,
        events: page.events,
        nextCursor: page.events.at(-1)?.cursor,
        cursorExpired: hasExpiredCursor(cursor, page.cursorFound),
      };
    } finally {
      void generator.return(undefined).catch(() => undefined);
    }
  }

  async *watchAgentOutput(input: WatchAgentOutputInput): AsyncGenerator<AgentOutputEvent, void, unknown> {
    const safeRunId = validateSegment(input.runId, 'runId');
    const cursor = input.cursor === undefined ? undefined : validateCursor(input.cursor);
    if (!this.dbos) {
      throw new AgentObservabilityError('DBOS_STREAM_UNAVAILABLE', 'DBOS stream reader is not configured');
    }
    let cursorFound = cursor === undefined;
    let scannedBeforeCursor = 0;
    for await (const raw of this.dbos.readStream<AgentOutputEvent>(safeRunId, AGENT_OUTPUT_STREAM_KEY)) {
      if (!cursorFound) scannedBeforeCursor += 1;
      const event = normalizeOutputEvent(safeRunId, raw);
      if (!event) {
        if (scannedBeforeCursor >= MAX_STREAM_EVENT_LIMIT) throw cursorExpiredError();
        continue;
      }
      if (cursorFound) {
        yield event;
        continue;
      }
      cursorFound = event.cursor === cursor;
      if (cursorFound) continue;
      if (scannedBeforeCursor >= MAX_STREAM_EVENT_LIMIT) throw cursorExpiredError();
    }
    if (hasExpiredCursor(cursor, cursorFound)) {
      throw cursorExpiredError();
    }
  }

  async *watchAgentActivity(input: WatchAgentOutputInput): AsyncGenerator<AgentRunActivity, void, unknown> {
    const snapshots = new Map<string, AgentActivitySnapshot>();
    for await (const event of this.watchAgentOutput(input)) {
      if (!event.snapshot) continue;
      snapshots.set(event.attemptId, this.classifySnapshot(event.snapshot));
      yield this.buildRunActivity(event.runId, [...snapshots.values()]);
    }
  }

  async listAgentAttempts(runId: string): Promise<AgentAttemptSummary[]> {
    const safeRunId = validateSegment(runId, 'runId');
    const runDir = await this.resolveRunDirectory(safeRunId);
    if (!runDir.exists) return [];

    const entries = await readdir(runDir.path, { withFileTypes: true });
    const attempts: AttemptCandidate[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw validationFailure('artifact attempt must not be a symlink');
      }
      if (!entry.isDirectory()) continue;

      const attemptId = validateSegment(entry.name, 'attemptId');
      const attemptDir = join(runDir.path, attemptId);
      await ensureDirectoryInsideRoot(attemptDir, runDir.realRoot, 'agent attempt');
      attempts.push(await this.readAttemptSummary(safeRunId, attemptId, attemptDir, runDir.realRoot));
    }

    return attempts
      .sort((a, b) => {
        const timeDiff = compareOptionalTimeAsc(a.startedSortAt, b.startedSortAt);
        return timeDiff !== 0 ? timeDiff : a.attemptId.localeCompare(b.attemptId);
      })
      .map(({ latestSortAt: _latestSortAt, startedSortAt: _startedSortAt, ...summary }) => summary);
  }

  async getAgentLog(input: GetAgentLogInput): Promise<AgentLogChunk> {
    const safeRunId = validateSegment(input.runId, 'runId');
    const stream = validateStream(input.stream);
    const bounds = validateBounds(input);
    const explicitAttemptId = input.attemptId !== undefined ? validateSegment(input.attemptId, 'attemptId') : undefined;
    const runDir = await this.resolveRunDirectory(safeRunId);

    const attemptId = explicitAttemptId ?? (await this.selectLatestAttemptId(safeRunId));

    if (!runDir.exists) {
      throw new AgentObservabilityError('NO_AGENT_ATTEMPT_AVAILABLE', 'no agent attempt artifacts are available');
    }

    const attemptDir = join(runDir.path, attemptId);
    const attemptExists = await directoryExistsInsideRoot(attemptDir, runDir.realRoot, 'agent attempt');
    if (!attemptExists) {
      throw new AgentObservabilityError('NO_AGENT_ATTEMPT_AVAILABLE', 'agent attempt artifacts are not available');
    }

    if (stream === 'combined') {
      return this.readCombinedLog(safeRunId, attemptId, attemptDir, runDir.realRoot, bounds);
    }

    const file = await resolveOptionalFile(join(attemptDir, LOG_FILES[stream]), runDir.realRoot, `${stream} log`);
    if (!file.exists) return emptyChunk(safeRunId, attemptId, stream);

    const chunk = await readFileChunk(file, bounds);
    return {
      runId: safeRunId,
      attemptId,
      stream,
      ...chunk,
    };
  }

  private async selectLatestAttemptId(runId: string): Promise<string> {
    const attempts = await this.listAgentAttempts(runId);
    if (attempts.length === 0) {
      throw new AgentObservabilityError('NO_AGENT_ATTEMPT_AVAILABLE', 'no agent attempt artifacts are available');
    }

    return attempts
      .map((attempt): AttemptCandidate => ({
        ...attempt,
        latestSortAt: parseDate(attempt.finishedAt) ?? parseDate(attempt.startedAt),
      }))
      .sort((a, b) => {
        const timeDiff = compareOptionalTimeAsc(a.latestSortAt, b.latestSortAt);
        return timeDiff !== 0 ? timeDiff : a.attemptId.localeCompare(b.attemptId);
      })
      .at(-1)!.attemptId;
  }

  private async getAgentActivityFromArtifacts(runId: string): Promise<AgentRunActivity | null> {
    let attempts: AgentAttemptSummary[];
    try {
      attempts = await this.listAgentAttempts(runId);
    } catch (err) {
      if (err instanceof AgentObservabilityError) {
        if (err.code === 'NO_AGENT_ATTEMPT_AVAILABLE') return null;
      }
      throw err;
    }
    if (attempts.length === 0) return null;
    return this.buildRunActivity(
      runId,
      attempts.map((attempt): AgentActivitySnapshot => {
        const finishedAt = attempt.finishedAt;
        const latestAt = finishedAt ?? attempt.startedAt;
        const snapshot: AgentActivitySnapshot = {
          runId,
          attemptId: attempt.attemptId,
          stepId: attempt.stepId,
          ...(attempt.stepKey ? { stepKey: attempt.stepKey } : {}),
          role: attempt.role,
          runner: attempt.runner,
          status: statusFromArtifact(attempt.status, attempt.timedOut),
          startedAt: attempt.startedAt,
          lastEventAt: latestAt,
          stdoutBytes: attempt.stdoutBytes,
          stderrBytes: attempt.stderrBytes,
          eventCount: 0,
          artifactRef: attempt.artifactRef,
        };
        if (finishedAt) snapshot.lastOutputAt = finishedAt;
        const exitCode = attempt.exitCode;
        if (exitCode === null || typeof exitCode === 'number') snapshot.exitCode = exitCode;
        const timedOut = attempt.timedOut;
        if (typeof timedOut === 'boolean') snapshot.timedOut = timedOut;
        return snapshot;
      }),
    );
  }

  private async readLatestAgentActivityFromStream(runId: string): Promise<AgentRunActivity | null> {
    if (!this.dbos) return null;
    const generator = this.dbos.readStream<AgentOutputEvent>(runId, AGENT_OUTPUT_STREAM_KEY);
    const snapshots = new Map<string, AgentActivitySnapshot>();
    let scanned = 0;
    try {
      while (scanned < MAX_STREAM_ACTIVITY_SCAN_EVENTS) {
        const next = await nextWithTimeout(generator, DEFAULT_STREAM_READ_TIMEOUT_MS);
        if (next === 'timeout' || next.done) break;
        scanned += 1;
        const event = normalizeOutputEvent(runId, next.value);
        if (event?.snapshot) snapshots.set(event.attemptId, event.snapshot);
      }
    } finally {
      void generator.return(undefined).catch(() => undefined);
    }
    if (scanned >= MAX_STREAM_ACTIVITY_SCAN_EVENTS) return null;
    if (snapshots.size === 0) return null;
    return this.buildRunActivity(runId, [...snapshots.values()]);
  }

  private buildRunActivity(runId: string, attempts: AgentActivitySnapshot[]): AgentRunActivity {
    return buildRunActivity(runId, attempts.map((attempt) => this.classifySnapshot(redactActivitySnapshot(attempt))));
  }

  private classifyActivity(activity: AgentRunActivity): AgentRunActivity {
    return this.buildRunActivity(activity.runId, activity.attempts);
  }

  private classifySnapshot(snapshot: AgentActivitySnapshot): AgentActivitySnapshot {
    if (snapshot.status !== 'starting' && snapshot.status !== 'running') return snapshot;
    const latestAt = parseDate(snapshot.lastOutputAt) ?? parseDate(snapshot.lastEventAt);
    if (latestAt === undefined) return snapshot;
    if (this.now() - latestAt < this.idleThresholdMs) return snapshot;
    return { ...snapshot, status: 'idle' };
  }

  private async assertRunExists(runId: string): Promise<void> {
    if (!this.runExists) return;
    const exists = await this.runExists(runId);
    if (!exists) throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
  }

  private async resolveRunDirectory(runId: string): Promise<ExistingRunDirectory> {
    if (this.runExists) {
      const exists = await this.runExists(runId);
      if (!exists) throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
    }

    const realRoot = await resolveRootIfPresent(this.artifactRoot);
    const runPath = join(this.artifactRoot, runId);
    const exists = realRoot
      ? await directoryExistsInsideRoot(runPath, realRoot, 'run artifact')
      : false;

    if (!exists) {
      if (this.runExists) return { exists: false, realRoot };
      throw new AgentObservabilityError('RUN_NOT_FOUND', 'run artifact directory was not found');
    }

    if (!realRoot) throw new AgentObservabilityError('RUN_NOT_FOUND', 'run artifact directory was not found');
    return { exists: true, path: runPath, realRoot };
  }

  private async readAttemptSummary(
    runId: string,
    attemptId: string,
    attemptDir: string,
    realRoot: string,
  ): Promise<AttemptCandidate> {
    const dirStat = await lstat(attemptDir);
    const meta = await readMetadata(join(attemptDir, 'meta.json'), realRoot);
    const stdoutBytes = await optionalFileSize(join(attemptDir, 'stdout.log'), realRoot, 'stdout log');
    const stderrBytes = await optionalFileSize(join(attemptDir, 'stderr.log'), realRoot, 'stderr log');
    const startedAt = stringValue(meta.startedAt) ?? dirStat.mtime.toISOString();
    const finishedAt = stringValue(meta.finishedAt);
    const exitCode = numberOrNull(meta.exitCode) ?? numberOrNull(meta.code);
    const timedOut = booleanValue(meta.timedOut);

    const summary: AttemptCandidate = {
      runId,
      attemptId,
      stepId: redactPublicText(stringValue(meta.stepId) ?? ''),
      role: redactPublicText(stringValue(meta.role) ?? 'unknown'),
      runner: redactPublicText(stringValue(meta.runner) ?? 'unknown'),
      artifactRef: validateArtifactRef(`${runId}/${attemptId}`),
      startedAt: redactPublicText(startedAt),
      status: redactPublicText(stringValue(meta.status) ?? 'unknown'),
      stdoutBytes,
      stderrBytes,
      startedSortAt: parseDate(startedAt),
      latestSortAt: parseDate(finishedAt) ?? parseDate(startedAt),
    };

    const stepKey = stringValue(meta.stepKey);
    if (stepKey) summary.stepKey = redactPublicText(stepKey);
    if (finishedAt) summary.finishedAt = redactPublicText(finishedAt);
    if (exitCode !== undefined) summary.exitCode = exitCode;
    if (timedOut !== undefined) summary.timedOut = timedOut;

    return summary;
  }

  private async readCombinedLog(
    runId: string,
    attemptId: string,
    attemptDir: string,
    realRoot: string,
    bounds: ReadBounds,
  ): Promise<AgentLogChunk> {
    const stdout = await resolveOptionalFile(join(attemptDir, 'stdout.log'), realRoot, 'stdout log');
    const stderr = await resolveOptionalFile(join(attemptDir, 'stderr.log'), realRoot, 'stderr log');
    const segments: SyntheticSegment[] = [
      bufferSegment(STDOUT_MARKER),
      { kind: 'file', file: stdout, size: stdout.size },
      bufferSegment(STDERR_MARKER),
      { kind: 'file', file: stderr, size: stderr.size },
    ];
    const chunk = await readSyntheticChunk(segments, bounds);

    return {
      runId,
      attemptId,
      stream: 'combined',
      ...chunk,
    };
  }
}

function validateSegment(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('/') ||
    value.includes('\\') ||
    value === '.' ||
    value === '..' ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    !SAFE_SEGMENT_RE.test(value)
  ) {
    throw validationFailure(`invalid ${label}`);
  }
  return value;
}

function validateArtifactRef(value: string): string {
  const parts = value.split('/');
  if (parts.length !== 2) throw validationFailure('invalid artifactRef');
  return `${validateSegment(parts[0] ?? '', 'artifactRef runId')}/${validateSegment(
    parts[1] ?? '',
    'artifactRef attemptId',
  )}`;
}

function validateStream(stream: AgentLogStream): AgentLogStream {
  if (stream !== 'stdout' && stream !== 'stderr' && stream !== 'events' && stream !== 'combined') {
    throw validationFailure('invalid log stream');
  }
  return stream;
}

function validateBounds(input: GetAgentLogInput): ReadBounds {
  const hasTail = input.tailBytes !== undefined;
  const hasOffsetOrLimit = input.offsetBytes !== undefined || input.limitBytes !== undefined;
  if (hasTail && hasOffsetOrLimit) {
    throw validationFailure('tailBytes cannot be combined with offsetBytes or limitBytes');
  }

  if (hasTail) {
    const tailBytes = validatePositiveByteCount(input.tailBytes, 'tailBytes');
    return { mode: 'tail', tailBytes };
  }

  if (hasOffsetOrLimit) {
    const offsetBytes = input.offsetBytes ?? 0;
    if (!Number.isInteger(offsetBytes) || offsetBytes < 0) throw validationFailure('offsetBytes must be non-negative');
    const limitBytes = validatePositiveByteCount(input.limitBytes ?? DEFAULT_READ_BYTES, 'limitBytes');
    return { mode: 'offset', offsetBytes, limitBytes };
  }

  return { mode: 'tail', tailBytes: DEFAULT_READ_BYTES };
}

function validatePositiveByteCount(value: number | undefined, label: string): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    throw validationFailure(`${label} must be a positive integer`);
  }
  if (value > MAX_READ_BYTES) throw validationFailure(`${label} exceeds maximum allowed bytes`);
  return value;
}

function validateEventLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_STREAM_EVENT_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw validationFailure('limit must be a positive integer');
  if (limit > MAX_STREAM_EVENT_LIMIT) throw validationFailure('limit exceeds maximum allowed events');
  return limit;
}

function validateStreamTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_STREAM_READ_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout <= 0) throw validationFailure('timeoutMs must be a positive integer');
  return timeout;
}

function validateIdleThreshold(value: number | undefined): number {
  const threshold = value ?? DEFAULT_IDLE_THRESHOLD_MS;
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw validationFailure('idleThresholdMs must be a positive integer');
  }
  return threshold;
}

function validateCursor(value: string): string {
  if (value.length === 0 || value.length > 512 || !SAFE_CURSOR_RE.test(value)) {
    throw validationFailure('invalid cursor');
  }
  return value;
}

type BoundedOutputEventsInput = {
  generator: AsyncGenerator<AgentOutputEvent, void, unknown>;
  runId: string;
  cursor?: string;
  limit: number;
  timeoutMs: number;
};

type BoundedOutputEventsResult = {
  events: AgentOutputEvent[];
  cursorFound: boolean;
};

async function readBoundedOutputEvents(input: BoundedOutputEventsInput): Promise<BoundedOutputEventsResult> {
  const events: AgentOutputEvent[] = [];
  let cursorFound = input.cursor === undefined;
  let scannedBeforeCursor = 0;

  while (events.length < input.limit) {
    const next = await nextWithTimeout(input.generator, input.timeoutMs);
    if (next === 'timeout' || next.done) break;
    const state = processOutputEventCandidate(input.runId, input.cursor, next.value, cursorFound, scannedBeforeCursor);
    cursorFound = state.cursorFound;
    scannedBeforeCursor = state.scannedBeforeCursor;
    if (state.event) events.push(state.event);
    if (state.stop) break;
  }

  return { events, cursorFound };
}

type OutputEventCandidateState = {
  event?: AgentOutputEvent;
  cursorFound: boolean;
  scannedBeforeCursor: number;
  stop: boolean;
};

function processOutputEventCandidate(
  runId: string,
  cursor: string | undefined,
  value: unknown,
  cursorFound: boolean,
  scannedBeforeCursor: number,
): OutputEventCandidateState {
  const nextScanned = cursorFound ? scannedBeforeCursor : scannedBeforeCursor + 1;
  const event = normalizeOutputEvent(runId, value);
  if (event) {
    if (cursorFound) return { event, cursorFound, scannedBeforeCursor: nextScanned, stop: false };

    const found = event.cursor === cursor;
    return {
      cursorFound: found,
      scannedBeforeCursor: nextScanned,
      stop: cursorMissedScanLimit(found, nextScanned),
    };
  }

  return {
    cursorFound,
    scannedBeforeCursor: nextScanned,
    stop: cursor !== undefined && cursorFound === false && nextScanned >= MAX_STREAM_EVENT_LIMIT,
  };
}

function hasExpiredCursor(cursor: string | undefined, cursorFound: boolean): boolean {
  return typeof cursor === 'string' && cursorFound === false;
}

function cursorExpiredError(): AgentObservabilityError {
  return new AgentObservabilityError('STREAM_CURSOR_EXPIRED', 'stream cursor was not found before the scan limit');
}

function cursorMissedScanLimit(cursorFound: boolean, scannedBeforeCursor: number): boolean {
  if (cursorFound) return false;
  return scannedBeforeCursor >= MAX_STREAM_EVENT_LIMIT;
}

async function nextWithTimeout<T>(
  generator: AsyncGenerator<T, void, unknown>,
  timeoutMs: number,
): Promise<IteratorResult<T, void> | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<IteratorResult<T, void> | 'timeout'>([
      generator.next(),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeOutputEvent(runId: string, value: unknown): AgentOutputEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as AgentOutputEvent;
  if (event.runId !== runId) return null;
  if (typeof event.cursor !== 'string' || event.cursor.length === 0) return null;
  if (typeof event.attemptId !== 'string' || event.attemptId.length === 0) return null;
  if (typeof event.stepId !== 'string') return null;
  if (typeof event.at !== 'string') return null;
  if (
    event.kind !== 'activity' &&
    event.kind !== 'output' &&
    event.kind !== 'parsed_event' &&
    event.kind !== 'status'
  ) {
    return null;
  }
  return event;
}

function redactActivitySnapshot(snapshot: AgentActivitySnapshot): AgentActivitySnapshot {
  return {
    ...snapshot,
    stepId: redactPublicText(snapshot.stepId),
    ...(snapshot.stepKey ? { stepKey: redactPublicText(snapshot.stepKey) } : {}),
    role: redactPublicText(snapshot.role),
    runner: redactPublicText(snapshot.runner),
    artifactRef: redactPublicText(snapshot.artifactRef),
    ...(snapshot.error ? { error: redactPublicText(snapshot.error) } : {}),
  };
}

function buildRunActivity(runId: string, attempts: AgentActivitySnapshot[]): AgentRunActivity {
  const sorted = [...attempts];
  sorted.sort((a, b) => {
    const startedDiff = (parseDate(a.startedAt) ?? 0) - (parseDate(b.startedAt) ?? 0);
    if (startedDiff === 0) return a.attemptId.localeCompare(b.attemptId);
    return startedDiff;
  });
  const activityTimes = sorted
    .map((attempt) => attempt.lastEventAt || attempt.startedAt)
    .sort((a, b) => a.localeCompare(b));
  const latestActivityAt = activityTimes.at(-1) ?? new Date(0).toISOString();
  const outputTimes = sorted
    .map((attempt) => attempt.lastOutputAt)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .sort((a, b) => a.localeCompare(b));
  const latestOutputAt = outputTimes.at(-1);
  return {
    runId,
    aggregateStatus: aggregateStatus(sorted),
    latestActivityAt,
    ...(latestOutputAt ? { latestOutputAt } : {}),
    attempts: sorted,
  };
}

function aggregateStatus(attempts: AgentActivitySnapshot[]): AgentActivityStatus {
  const statuses = new Set(attempts.map((attempt) => attempt.status));
  if (statuses.has('timed_out')) return 'timed_out';
  if (statuses.has('cancelled')) return 'cancelled';
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('permission_blocked')) return 'permission_blocked';
  if (statuses.has('running') || statuses.has('starting')) return 'running';
  if (statuses.has('idle')) return 'idle';
  return 'exited';
}

function statusFromArtifact(status: string, timedOut: boolean | undefined): AgentActivityStatus {
  if (timedOut || status === 'timed_out') return 'timed_out';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'running' || status === 'starting') return 'running';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'permission_blocked') return 'permission_blocked';
  if (status === 'idle') return 'idle';
  return 'exited';
}

async function resolveRootIfPresent(root: string): Promise<string | undefined> {
  try {
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw validationFailure('artifact root must be a directory');
    }
    return await realpath(root);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function directoryExistsInsideRoot(path: string, realRoot: string, label: string): Promise<boolean> {
  try {
    await ensureDirectoryInsideRoot(path, realRoot, label);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function ensureDirectoryInsideRoot(path: string, realRoot: string, label: string): Promise<void> {
  const itemStat = await lstat(path);
  if (itemStat.isSymbolicLink()) throw validationFailure(`${label} must not be a symlink`);
  if (!itemStat.isDirectory()) throw validationFailure(`${label} must be a directory`);
  assertInsideRoot(await realpath(path), realRoot);
}

async function resolveOptionalFile(path: string, realRoot: string, label: string): Promise<FileInfo> {
  try {
    const itemStat = await lstat(path);
    if (itemStat.isSymbolicLink()) throw validationFailure(`${label} must not be a symlink`);
    if (!itemStat.isFile()) throw validationFailure(`${label} must be a file`);
    const realFilePath = await realpath(path);
    assertInsideRoot(realFilePath, realRoot);
    return { exists: true, path: realFilePath, size: itemStat.size };
  } catch (error) {
    if (isNotFound(error)) return { exists: false, size: 0 };
    throw error;
  }
}

async function optionalFileSize(path: string, realRoot: string, label: string): Promise<number> {
  return (await resolveOptionalFile(path, realRoot, label)).size;
}

async function readMetadata(path: string, realRoot: string): Promise<AgentLogMeta> {
  const file = await resolveOptionalFile(path, realRoot, 'metadata');
  if (!file.exists) return {};
  if (file.size > MAX_METADATA_BYTES) {
    throw validationFailure('artifact metadata exceeds maximum allowed bytes');
  }

  try {
    const content = await readFile(file.path, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as AgentLogMeta) : {};
  } catch {
    throw validationFailure('invalid artifact metadata');
  }
}

async function readFileChunk(
  file: Extract<FileInfo, { exists: true }>,
  bounds: ReadBounds,
): Promise<Omit<AgentLogChunk, 'runId' | 'attemptId' | 'stream'>> {
  const totalBytes = file.size;
  const range = rangeForBounds(totalBytes, bounds);
  if (range.start === range.end) {
    return {
      offsetBytes: range.start,
      nextOffsetBytes: range.end,
      totalBytes,
      truncated: range.truncated,
      content: '',
    };
  }

  const expanded = expandRange(range.start, range.end, totalBytes, SENSITIVE_BOUNDARY_SCAN_BYTES);
  const expandedWindow = alignUtf8Window(await readFileRange(file.path, expanded.start, expanded.end), expanded.start);
  const aligned = alignUtf8Range(
    expandedWindow.buffer,
    range.start - expandedWindow.absoluteStart,
    range.end - expandedWindow.absoluteStart,
    expandedWindow.absoluteStart,
  );
  const content = redactPublicChunk(expandedWindow, aligned, totalBytes);

  return {
    offsetBytes: aligned.start,
    nextOffsetBytes: aligned.end,
    totalBytes,
    truncated: bounds.mode === 'tail' ? aligned.start > 0 : aligned.end < totalBytes,
    content,
  };
}

async function readSyntheticChunk(
  segments: SyntheticSegment[],
  bounds: ReadBounds,
): Promise<Omit<AgentLogChunk, 'runId' | 'attemptId' | 'stream'>> {
  const totalBytes = segments.reduce((sum, segment) => sum + segment.size, 0);
  const range = rangeForBounds(totalBytes, bounds);
  if (range.start === range.end) {
    return {
      offsetBytes: range.start,
      nextOffsetBytes: range.end,
      totalBytes,
      truncated: range.truncated,
      content: '',
    };
  }

  const expanded = expandRange(range.start, range.end, totalBytes, SENSITIVE_BOUNDARY_SCAN_BYTES);
  const expandedWindow = alignUtf8Window(await readSyntheticRange(segments, expanded.start, expanded.end), expanded.start);
  const aligned = alignUtf8Range(
    expandedWindow.buffer,
    range.start - expandedWindow.absoluteStart,
    range.end - expandedWindow.absoluteStart,
    expandedWindow.absoluteStart,
  );
  const content = redactPublicChunk(expandedWindow, aligned, totalBytes);

  return {
    offsetBytes: aligned.start,
    nextOffsetBytes: aligned.end,
    totalBytes,
    truncated: bounds.mode === 'tail' ? aligned.start > 0 : aligned.end < totalBytes,
    content,
  };
}

function rangeForBounds(totalBytes: number, bounds: ReadBounds): { start: number; end: number; truncated: boolean } {
  if (bounds.mode === 'tail') {
    const start = Math.max(0, totalBytes - bounds.tailBytes);
    return { start, end: totalBytes, truncated: start > 0 };
  }

  const start = Math.min(bounds.offsetBytes, totalBytes);
  const end = Math.min(totalBytes, start + bounds.limitBytes);
  return { start, end, truncated: end < totalBytes };
}

function expandRange(start: number, end: number, totalBytes: number, contextBytes: number): { start: number; end: number } {
  return {
    start: Math.max(0, start - contextBytes - UTF8_BOUNDARY_CONTEXT_BYTES),
    end: Math.min(totalBytes, end + contextBytes + UTF8_BOUNDARY_CONTEXT_BYTES),
  };
}

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, constants.O_RDONLY);
  try {
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === length ? buffer : buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

async function readSyntheticRange(segments: SyntheticSegment[], start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.size;
    cursor = segmentEnd;
    if (end <= segmentStart || start >= segmentEnd) continue;

    const localStart = Math.max(0, start - segmentStart);
    const localEnd = Math.min(segment.size, end - segmentStart);
    if (segment.kind === 'buffer') {
      chunks.push(segment.buffer.subarray(localStart, localEnd));
    } else if (segment.file.exists) {
      chunks.push(await readFileRange(segment.file.path, localStart, localEnd));
    }
  }
  return Buffer.concat(chunks);
}

function alignUtf8Range(
  buffer: Buffer,
  requestedStartIndex: number,
  requestedEndIndex: number,
  absoluteBufferStart: number,
): { startIndex: number; endIndex: number; start: number; end: number } {
  let startIndex = Math.max(0, requestedStartIndex);
  while (startIndex < buffer.length && isUtf8ContinuationByte(buffer[startIndex])) startIndex += 1;

  let endIndex = Math.min(buffer.length, requestedEndIndex);
  while (endIndex > startIndex && endIndex < buffer.length && isUtf8ContinuationByte(buffer[endIndex])) endIndex -= 1;
  if (endIndex < startIndex) endIndex = startIndex;

  return {
    startIndex,
    endIndex,
    start: absoluteBufferStart + startIndex,
    end: absoluteBufferStart + endIndex,
  };
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0b1100_0000) === 0b1000_0000;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw validationFailure('log content is not valid UTF-8');
  }
}

function redactPublicChunk(
  expandedWindow: AlignedWindow,
  aligned: { startIndex: number; endIndex: number; start: number; end: number },
  totalBytes: number,
): string {
  const expandedText = decodeUtf8(expandedWindow.buffer);
  const absoluteBufferStart = expandedWindow.absoluteStart;
  const absoluteBufferEnd = expandedWindow.absoluteStart + expandedWindow.buffer.byteLength;
  const sensitiveSpans = findSensitiveSpans(
    expandedText,
    absoluteBufferStart,
    absoluteBufferEnd,
    totalBytes,
    aligned.start,
    aligned.end,
  );
  const requestedStart = aligned.start;
  const requestedEnd = aligned.end;
  let cursor = requestedStart;
  let content = '';

  for (const span of sensitiveSpans) {
    if (span.end <= cursor || span.start >= requestedEnd) continue;
    const safeEnd = Math.min(span.start, requestedEnd);
    if (cursor < safeEnd) {
      content += decodeUtf8(
        expandedWindow.buffer.subarray(cursor - absoluteBufferStart, safeEnd - absoluteBufferStart),
      );
    }
    content += span.replacement;
    cursor = Math.min(Math.max(cursor, span.end), requestedEnd);
  }

  if (cursor < requestedEnd) {
    content += decodeUtf8(
      expandedWindow.buffer.subarray(cursor - absoluteBufferStart, requestedEnd - absoluteBufferStart),
    );
  }

  return redactPublicText(content);
}

function alignUtf8Window(buffer: Buffer, absoluteStart: number): AlignedWindow {
  let startIndex = 0;
  while (startIndex < buffer.length && isUtf8ContinuationByte(buffer[startIndex])) startIndex += 1;

  for (let endIndex = buffer.length; endIndex >= startIndex; endIndex -= 1) {
    const candidate = buffer.subarray(startIndex, endIndex);
    try {
      UTF8_DECODER.decode(candidate);
      return {
        buffer: candidate,
        absoluteStart: absoluteStart + startIndex,
      };
    } catch {
      if (buffer.length - endIndex > UTF8_BOUNDARY_CONTEXT_BYTES) break;
    }
  }

  throw validationFailure('log content is not valid UTF-8');
}

function findSensitiveSpans(
  text: string,
  absoluteBufferStart: number,
  absoluteBufferEnd: number,
  totalBytes: number,
  requestedStart: number,
  requestedEnd: number,
): SensitiveSpan[] {
  return [
    ...findPatternSpans(text, TOKEN_PATTERN, '[REDACTED]', absoluteBufferStart),
    ...findPatternSpans(text, WINDOWS_PATH_PATTERN, '[REDACTED_PATH]', absoluteBufferStart),
    ...findPatternSpans(text, POSIX_PATH_PATTERN, '[REDACTED_PATH]', absoluteBufferStart),
    ...findUnprovenSensitiveSpans(
      text,
      absoluteBufferStart,
      absoluteBufferEnd,
      totalBytes,
      requestedStart,
      requestedEnd,
    ),
  ].sort((a, b) => {
    const diff = a.start - b.start;
    if (diff !== 0) return diff;
    return b.end - a.end;
  });
}

function findUnprovenSensitiveSpans(
  text: string,
  absoluteBufferStart: number,
  absoluteBufferEnd: number,
  totalBytes: number,
  requestedStart: number,
  requestedEnd: number,
): SensitiveSpan[] {
  const spans: SensitiveSpan[] = [];
  let runStartIndex: number | undefined;

  for (let index = 0; index <= text.length; index += 1) {
    const char = index < text.length ? text[index] : undefined;
    if (char !== undefined && !isSensitiveDelimiter(char)) {
      runStartIndex ??= index;
      continue;
    }

    if (runStartIndex === undefined) continue;

    const runEndIndex = index;
    const runStart = absoluteBufferStart + Buffer.byteLength(text.slice(0, runStartIndex), 'utf8');
    const runEnd = absoluteBufferStart + Buffer.byteLength(text.slice(0, runEndIndex), 'utf8');
    const leftBoundaryProven = runStartIndex > 0 || absoluteBufferStart === 0;
    const rightBoundaryProven = runEndIndex < text.length || absoluteBufferEnd === totalBytes;

    if (
      runEnd > requestedStart &&
      runStart < requestedEnd &&
      (!leftBoundaryProven || !rightBoundaryProven)
    ) {
      spans.push({
        start: runStart,
        end: runEnd,
        replacement: runContainsPathSeparator(text.slice(runStartIndex, runEndIndex))
          ? '[REDACTED_PATH]'
          : '[REDACTED]',
      });
    }

    runStartIndex = undefined;
  }

  return spans;
}

function isSensitiveDelimiter(char: string): boolean {
  return /\s/.test(char) || '"\'`<>(){}[],;'.includes(char);
}

function runContainsPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\');
}

function findPatternSpans(
  text: string,
  pattern: RegExp,
  replacement: string,
  absoluteBufferStart: number,
): SensitiveSpan[] {
  const spans: SensitiveSpan[] = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const matchText = match[0];
    if (match.index === undefined || matchText.length === 0) continue;
    const start = absoluteBufferStart + Buffer.byteLength(text.slice(0, match.index), 'utf8');
    const end = start + Buffer.byteLength(matchText, 'utf8');
    spans.push({ start, end, replacement });
  }
  return spans;
}

function bufferSegment(value: string): SyntheticSegment {
  const buffer = Buffer.from(value, 'utf8');
  return { kind: 'buffer', buffer, size: buffer.byteLength };
}

function assertInsideRoot(candidateRealPath: string, realRoot: string): void {
  const rel = relative(realRoot, candidateRealPath);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel) || win32.isAbsolute(rel)) {
    throw validationFailure('artifact path escapes the artifact root');
  }
}

function emptyChunk(runId: string, attemptId: string, stream: AgentLogStream): AgentLogChunk {
  return {
    runId,
    attemptId,
    stream,
    offsetBytes: 0,
    totalBytes: 0,
    truncated: false,
    content: '',
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function compareOptionalTimeAsc(left: number | undefined, right: number | undefined): number {
  if (left !== undefined && right !== undefined) return left - right;
  if (left === undefined && right !== undefined) return -1;
  if (left !== undefined && right === undefined) return 1;
  return 0;
}

function redactPublicText(text: string): string {
  return redactTokens(text)
    .replace(/\b[A-Za-z]:\\[^\s'"`]+/g, '[REDACTED_PATH]')
    .replace(/(^|[\s"'`=:(])\/(?:Users|private|tmp|var|opt|home|workspace|Volumes)\/[^\s"'`)]+/g, '$1[REDACTED_PATH]');
}

function validationFailure(message: string): AgentObservabilityError {
  return new AgentObservabilityError('VALIDATION_FAILURE', message);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
