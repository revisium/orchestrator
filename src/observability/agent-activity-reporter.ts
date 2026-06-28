import { redactTokens } from '../runners/gh-identity.js';
import type {
  AgentActivitySnapshot,
  AgentActivityStatus,
  AgentOutputEvent,
  AgentOutputEventKind,
  AgentOutputStream,
} from './types.js';

export type AgentActivityReporterWriter = (event: AgentOutputEvent) => Promise<void>;

export type AgentActivityReporterStart = {
  runId: string;
  attemptId: string;
  stepId: string;
  stepKey?: string;
  role: string;
  runner: string;
  startedAt?: Date;
  writeTimeoutMs?: number;
};

export type AgentActivityReporter = {
  started(): void;
  spawned(pid: number): void;
  output(stream: Extract<AgentOutputStream, 'stdout' | 'stderr'>, chunk: string): void;
  parsed(event: { type?: string; preview?: string }): void;
  status(status: AgentActivityStatus, detail?: { preview?: string }): void;
  finished(event: { exitCode?: number | null; timedOut?: boolean }): void;
  failed(error: unknown, detail?: { timedOut?: boolean; exitCode?: number | null }): void;
  flush(): Promise<void>;
  snapshot(): AgentActivitySnapshot;
};

const PREVIEW_MAX_BYTES = 1_000;
const ERROR_MAX_BYTES = 1_000;
const DEFAULT_WRITE_TIMEOUT_MS = 2_000;
const POSIX_PATH_PATTERN = /\/(?:Users|private|tmp|var|opt|home|workspace|Volumes)\/[^\s'"`)]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s'"`]+/g;
const SAFE_CURSOR_RE = /[^A-Za-z0-9_.:-]+/g;

function nowIso(): string {
  return new Date().toISOString();
}

function capUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let out = value;
  while (out.length > 0 && Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, -1);
  }
  return out;
}

function publicText(value: string, maxBytes = PREVIEW_MAX_BYTES): string {
  return capUtf8(
    redactTokens(value)
      .replace(POSIX_PATH_PATTERN, '[redacted-path]')
      .replace(WINDOWS_PATH_PATTERN, '[redacted-path]'),
    maxBytes,
  );
}

function safeCursorPart(value: string | undefined): string {
  const clean = (value ?? '-').replace(SAFE_CURSOR_RE, '_');
  return clean.length > 0 ? clean : '-';
}

function cursor(parts: Array<string | number | null | undefined>): string {
  return ['agent-output-v1', ...parts.map((part) => safeCursorPart(String(part ?? '-')))].join(':');
}

function errorMessage(error: unknown): string {
  return publicText(error instanceof Error ? error.message : String(error), ERROR_MAX_BYTES);
}

function cloneSnapshot(snapshot: AgentActivitySnapshot): AgentActivitySnapshot {
  return { ...snapshot };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T>([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`agent stream write timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createAgentActivityReporter(
  input: AgentActivityReporterStart,
  writeStream: AgentActivityReporterWriter,
): AgentActivityReporter {
  const startedAt = input.startedAt?.toISOString() ?? nowIso();
  const writeTimeoutMs = input.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const snapshot: AgentActivitySnapshot = {
    runId: input.runId,
    attemptId: input.attemptId,
    stepId: input.stepId,
    ...(input.stepKey ? { stepKey: input.stepKey } : {}),
    role: publicText(input.role),
    runner: publicText(input.runner),
    status: 'starting',
    startedAt,
    lastEventAt: startedAt,
    stdoutBytes: 0,
    stderrBytes: 0,
    eventCount: 0,
    artifactRef: `${input.runId}/${input.attemptId}`,
  };
  let drain = Promise.resolve();
  let attemptSeq = 0;
  let firstWriteFailure: unknown;

  function enqueue(kind: AgentOutputEventKind, patch: Partial<AgentOutputEvent> = {}): void {
    const at = patch.at ?? nowIso();
    snapshot.lastEventAt = at;
    snapshot.eventCount += 1;
    attemptSeq += 1;
    const event: AgentOutputEvent = {
      cursor: patch.cursor ?? cursor([input.runId, input.attemptId, kind, patch.statusHint, patch.stream, attemptSeq]),
      runId: input.runId,
      attemptId: input.attemptId,
      attemptSeq,
      stepId: input.stepId,
      ...(input.stepKey ? { stepKey: input.stepKey } : {}),
      at,
      kind,
      ...patch,
      snapshot: cloneSnapshot(snapshot),
    };
    drain = drain
      .then(() => withTimeout(writeStream(event), writeTimeoutMs))
      .catch((err: unknown) => {
        firstWriteFailure ??= err;
        console.warn(`[observability] agent stream write failed for ${input.runId}/${input.attemptId}: ${String(err)}`);
      });
  }

  return {
    started(): void {
      snapshot.status = 'starting';
      enqueue('activity', {
        statusHint: 'starting',
        cursor: cursor([input.runId, input.attemptId, 'started']),
      });
    },

    spawned(pid: number): void {
      snapshot.pid = pid;
      snapshot.status = 'running';
      enqueue('status', {
        statusHint: 'running',
        cursor: cursor([input.runId, input.attemptId, 'spawned', attemptSeq + 1]),
      });
    },

    output(stream, chunk): void {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      const offset = stream === 'stdout' ? snapshot.stdoutBytes : snapshot.stderrBytes;
      if (stream === 'stdout') snapshot.stdoutBytes += bytes;
      else snapshot.stderrBytes += bytes;
      snapshot.status = snapshot.status === 'starting' ? 'running' : snapshot.status;
      snapshot.lastOutputAt = nowIso();
      snapshot.lastEventAt = snapshot.lastOutputAt;
      snapshot.lastStream = stream;
      enqueue('output', {
        stream,
        bytes,
        outputOffsetBytes: offset,
        preview: publicText(chunk),
        cursor: cursor([input.runId, input.attemptId, 'output', stream, offset, bytes]),
        at: snapshot.lastOutputAt,
      });
    },

    parsed(event): void {
      enqueue('parsed_event', {
        stream: 'agent-jsonl',
        parsedType: publicText(event.type ?? 'unknown', 200),
        preview: event.preview ? publicText(event.preview) : undefined,
        cursor: cursor([input.runId, input.attemptId, 'parsed', attemptSeq + 1]),
      });
    },

    status(status, detail): void {
      snapshot.status = status;
      enqueue('status', {
        statusHint: status,
        preview: detail?.preview ? publicText(detail.preview) : undefined,
        cursor: cursor([input.runId, input.attemptId, 'status', status, attemptSeq + 1]),
      });
    },

    finished(event): void {
      snapshot.status = event.timedOut ? 'timed_out' : 'exited';
      snapshot.exitCode = event.exitCode ?? null;
      snapshot.timedOut = Boolean(event.timedOut);
      enqueue('status', {
        statusHint: snapshot.status,
        cursor: cursor([input.runId, input.attemptId, 'finished', snapshot.exitCode, snapshot.timedOut ? 'timed_out' : 'exited']),
      });
    },

    failed(error, detail): void {
      snapshot.status = detail?.timedOut ? 'timed_out' : 'failed';
      snapshot.exitCode = detail?.exitCode;
      snapshot.timedOut = detail?.timedOut;
      snapshot.error = errorMessage(error);
      enqueue('status', {
        statusHint: snapshot.status,
        preview: snapshot.error,
        cursor: cursor([input.runId, input.attemptId, 'failed', snapshot.status, snapshot.exitCode, attemptSeq + 1]),
      });
    },

    async flush(): Promise<void> {
      await drain;
      if (firstWriteFailure) {
        firstWriteFailure = undefined;
      }
    },

    snapshot(): AgentActivitySnapshot {
      return cloneSnapshot(snapshot);
    },
  };
}
