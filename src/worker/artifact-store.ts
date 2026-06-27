import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactTokens } from '../runners/gh-identity.js';
import type { RunnerTimeoutEvidence, RunnerTimeoutFailureKind } from './process-executor.js';

export type ProcessArtifactRef = {
  ref: string;
  dirPath: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  eventsPath: string;
};

export type ProcessArtifactSnapshot = {
  ref: string;
  stdoutTail: string;
  stderrTail: string;
};

export type ProcessArtifactWriter = {
  ref: ProcessArtifactRef;
  appendStdout(chunk: string): void;
  appendStderr(chunk: string): void;
  finish(info: {
    code?: number | null;
    timedOut?: boolean;
    timeoutKind?: RunnerTimeoutFailureKind;
    timeoutEvidence?: RunnerTimeoutEvidence;
    error?: string;
    finishedAt?: Date;
  }): ProcessArtifactSnapshot;
  snapshot(): ProcessArtifactSnapshot;
};

export type ProcessArtifactStart = {
  runId: string;
  attemptId: string;
  stepId: string;
  role: string;
  runner: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  wallClockLimitMs?: number;
  startedAt?: Date;
};

export type ArtifactStore = {
  resolveAttemptDir(runId: string, attemptId: string): string;
  startProcess(input: ProcessArtifactStart): ProcessArtifactWriter;
};

const DEFAULT_TAIL_BYTES = 4_000;
const SAFE_ID_RE = /^[A-Za-z0-9_.:-]+$/;

function safeSegment(value: string, label: string): string {
  if (!SAFE_ID_RE.test(value)) {
    throw new Error(`invalid ${label} for artifact path: ${value}`);
  }
  return value;
}

function capTail(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) return next;
  return next.slice(-maxBytes);
}

function sanitizeText(text: string): string {
  return redactTokens(text);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function timeoutPolicyFields(input: ProcessArtifactStart): {
  timeoutMs: number;
  idleTimeoutMs?: number;
  wallClockLimitMs?: number;
} {
  return {
    timeoutMs: input.timeoutMs,
    ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    ...(input.wallClockLimitMs === undefined ? {} : { wallClockLimitMs: input.wallClockLimitMs }),
  };
}

export function createArtifactStore(rootDir: string, opts: { tailBytes?: number } = {}): ArtifactStore {
  const root = resolve(rootDir);
  const tailBytes = opts.tailBytes ?? DEFAULT_TAIL_BYTES;

  return {
    resolveAttemptDir(runIdValue: string, attemptIdValue: string): string {
      const runId = safeSegment(runIdValue, 'runId');
      const attemptId = safeSegment(attemptIdValue, 'attemptId');
      return join(root, runId, attemptId);
    },

    startProcess(input: ProcessArtifactStart): ProcessArtifactWriter {
      const runId = safeSegment(input.runId, 'runId');
      const attemptId = safeSegment(input.attemptId, 'attemptId');
      const dir = join(root, runId, attemptId);
      mkdirSync(dir, { recursive: true });

      const ref = `${runId}/${attemptId}`;
      const stdoutPath = join(dir, 'stdout.log');
      const stderrPath = join(dir, 'stderr.log');
      const metaPath = join(dir, 'meta.json');
      const eventsPath = join(dir, 'events.jsonl');
      const startedAt = input.startedAt ?? new Date();
      let stdoutTail = '';
      let stderrTail = '';

      writeFileSync(stdoutPath, '', 'utf8');
      writeFileSync(stderrPath, '', 'utf8');
      writeJson(metaPath, {
        ref,
        runId,
        attemptId,
        stepId: input.stepId,
        role: input.role,
        runner: input.runner,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        ...timeoutPolicyFields(input),
        startedAt: startedAt.toISOString(),
        status: 'running',
      });
      appendFileSync(
        eventsPath,
        JSON.stringify({
          type: 'process_started',
          at: startedAt.toISOString(),
          ...timeoutPolicyFields(input),
        }) + '\n',
        'utf8',
      );

      const artifactRef: ProcessArtifactRef = { ref, dirPath: dir, stdoutPath, stderrPath, metaPath, eventsPath };
      const snapshot = (): ProcessArtifactSnapshot => ({ ref, stdoutTail, stderrTail });

      return {
        ref: artifactRef,
        appendStdout(chunk: string): void {
          const safe = sanitizeText(chunk);
          appendFileSync(stdoutPath, safe, 'utf8');
          stdoutTail = capTail(stdoutTail, safe, tailBytes);
        },
        appendStderr(chunk: string): void {
          const safe = sanitizeText(chunk);
          appendFileSync(stderrPath, safe, 'utf8');
          stderrTail = capTail(stderrTail, safe, tailBytes);
        },
        finish(info): ProcessArtifactSnapshot {
          const finishedAt = info.finishedAt ?? new Date();
          let status = 'finished';
          if (info.error) status = 'error';
          else if (info.timedOut) status = 'timed_out';
          const safeError = info.error ? sanitizeText(info.error) : '';
          writeJson(metaPath, {
            ref,
            runId,
            attemptId,
            stepId: input.stepId,
            role: input.role,
            runner: input.runner,
            command: input.command,
            args: input.args,
            cwd: input.cwd,
            ...timeoutPolicyFields(input),
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            status,
            code: info.code ?? null,
            timedOut: Boolean(info.timedOut),
            ...(info.timeoutKind === undefined ? {} : { timeoutKind: info.timeoutKind }),
            ...(info.timeoutEvidence === undefined ? {} : { timeoutEvidence: info.timeoutEvidence }),
            error: safeError,
          });
          appendFileSync(
            eventsPath,
            JSON.stringify({
              type: 'process_finished',
              at: finishedAt.toISOString(),
              status,
              code: info.code ?? null,
              timedOut: Boolean(info.timedOut),
              ...timeoutPolicyFields(input),
              ...(info.timeoutKind === undefined ? {} : { timeoutKind: info.timeoutKind }),
              ...(info.timeoutEvidence === undefined ? {} : { timeoutEvidence: info.timeoutEvidence }),
              error: safeError,
            }) + '\n',
            'utf8',
          );
          return snapshot();
        },
        snapshot,
      };
    },
  };
}
