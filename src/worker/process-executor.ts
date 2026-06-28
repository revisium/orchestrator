import { spawn, type ChildProcess } from 'node:child_process';
import {
  createRunnerActivityTracker,
  type RunnerActivityTracker,
  type RunnerActivityTrackerSnapshot,
} from '../observability/activity-signal.js';


export type ExecRequest = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  idleTimeoutMs?: number;
  input?: string;
  env?: Record<string, string>;
  onSpawn?: (pid: number) => void;
  onStdoutChunk?: (chunk: string) => void;
  onStderrChunk?: (chunk: string) => void;
  onActivityTracker?: (tracker: RunnerActivityTracker) => void;
};

export const RUNNER_IDLE_TIMEOUT_KIND = 'runner-idle-timeout' as const;
export const RUNNER_WALL_CLOCK_LIMIT_KIND = 'runner-wall-clock-limit' as const;
export type RunnerTimeoutFailureKind =
  | typeof RUNNER_IDLE_TIMEOUT_KIND
  | typeof RUNNER_WALL_CLOCK_LIMIT_KIND;

export const DEFAULT_RUNNER_IDLE_TIMEOUT_MS = 600_000;
export const DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS = 3_600_000;

export type RunnerTimeoutPolicy = {
  idleTimeoutMs: number;
  wallClockLimitMs: number;
};

export type RunnerTimeoutEvidence = {
  idleTimeoutMs: number;
  wallClockLimitMs: number;
  elapsedMs: number;
  idleMs: number;
  lastActivityAt: string;
  inFlightOperationCount: number;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
};

export type ExecResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutKind?: RunnerTimeoutFailureKind;
  timeoutEvidence?: RunnerTimeoutEvidence;
};

export type ProcessExecutor = (req: ExecRequest) => Promise<ExecResult>;

function readPositiveIntEnv(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${key} must be a positive integer number of milliseconds`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer number of milliseconds`);
  }
  return parsed;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer number of milliseconds`);
  }
  return value;
}

export function resolveRunnerTimeoutPolicy(
  opts: {
    idleTimeoutMs?: number;
    wallClockLimitMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): RunnerTimeoutPolicy {
  return resolveEffectiveRunnerTimeoutPolicy(opts);
}

export function resolveEffectiveRunnerTimeoutPolicy(
  opts: {
    idleTimeoutMs?: number;
    wallClockLimitMs?: number;
    roleTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): RunnerTimeoutPolicy {
  const env = opts.env ?? process.env;
  const roleWallClockLimitMs =
    typeof opts.roleTimeoutMs === 'number' && opts.roleTimeoutMs > 0
      ? opts.roleTimeoutMs
      : undefined;
  return {
    idleTimeoutMs: positiveInt(
      readPositiveIntEnv(env, 'REVO_RUNNER_IDLE_TIMEOUT_MS')
        ?? opts.idleTimeoutMs
        ?? DEFAULT_RUNNER_IDLE_TIMEOUT_MS,
      'idleTimeoutMs',
    ),
    wallClockLimitMs: positiveInt(
      readPositiveIntEnv(env, 'REVO_RUNNER_WALL_CLOCK_LIMIT_MS')
        ?? roleWallClockLimitMs
        ?? opts.wallClockLimitMs
        ?? DEFAULT_RUNNER_WALL_CLOCK_LIMIT_MS,
      'wallClockLimitMs',
    ),
  };
}

function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export const spawnExecutor: ProcessExecutor = (req) =>
  new Promise<ExecResult>((resolve, reject) => {
    const policy = resolveRunnerTimeoutPolicy({
      idleTimeoutMs: req.idleTimeoutMs,
      wallClockLimitMs: req.timeoutMs,
    });
    const startedAt = Date.now();
    const timers: {
      idle?: ReturnType<typeof setTimeout>;
      wallClock?: ReturnType<typeof setTimeout>;
    } = {};
    let latestActivity: RunnerActivityTrackerSnapshot | undefined;
    const activity = createRunnerActivityTracker({
      startedAt,
      onChange: (snapshot) => {
        latestActivity = snapshot;
        scheduleIdleTimer();
      },
    });

    const child = spawn(req.command, req.args, {
      cwd: req.cwd,
      env: req.env ? { ...process.env, ...req.env } : process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutKind: RunnerTimeoutFailureKind | undefined;
    let timeoutEvidence: RunnerTimeoutEvidence | undefined;
    let settled = false;

    function clearTimers(): void {
      if (timers.idle) clearTimeout(timers.idle);
      if (timers.wallClock) clearTimeout(timers.wallClock);
    }

    function rejectFromSetup(err: unknown): void {
      if (settled) return;
      settled = true;
      clearTimers();
      killGroup(child);
      reject(err);
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(err);
    });

    try {
      if (child.pid !== undefined) req.onSpawn?.(child.pid);
      req.onActivityTracker?.(activity);
    } catch (err) {
      rejectFromSetup(err);
      return;
    }

    function buildTimeoutEvidence(snapshot: RunnerActivityTrackerSnapshot): RunnerTimeoutEvidence {
      const now = Date.now();
      return {
        idleTimeoutMs: policy.idleTimeoutMs,
        wallClockLimitMs: policy.wallClockLimitMs,
        elapsedMs: Math.max(0, now - startedAt),
        idleMs: Math.max(0, now - snapshot.lastActivityAt),
        lastActivityAt: new Date(snapshot.lastActivityAt).toISOString(),
        inFlightOperationCount: snapshot.inFlightOperationCount,
        stdoutBytes: snapshot.stdoutBytes,
        stderrBytes: snapshot.stderrBytes,
        eventCount: snapshot.eventCount,
      };
    }

    function killFor(kind: RunnerTimeoutFailureKind): void {
      if (settled || timedOut) return;
      timedOut = true;
      timeoutKind = kind;
      timeoutEvidence = buildTimeoutEvidence(activity.snapshot());
      clearTimers();
      killGroup(child);
    }

    function scheduleIdleTimer(): void {
      if (settled || timedOut) return;
      if (timers.idle) clearTimeout(timers.idle);
      const snapshot = latestActivity ?? activity.snapshot();
      if (snapshot.inFlightOperationCount > 0) {
        timers.idle = setTimeout(scheduleIdleTimer, policy.idleTimeoutMs);
        return;
      }
      const idleMs = Math.max(0, Date.now() - snapshot.lastActivityAt);
      const remainingMs = policy.idleTimeoutMs - idleMs;
      if (remainingMs <= 0) {
        killFor(RUNNER_IDLE_TIMEOUT_KIND);
        return;
      }
      timers.idle = setTimeout(scheduleIdleTimer, remainingMs);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
      activity.recordOutput('stdout', Buffer.byteLength(chunk, 'utf8'));
      try {
        req.onStdoutChunk?.(chunk);
      } catch (err) {
        console.warn(`Warning: onStdoutChunk sink failed: ${String(err)}`);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      activity.recordOutput('stderr', Buffer.byteLength(chunk, 'utf8'));
      try {
        req.onStderrChunk?.(chunk);
      } catch (err) {
        console.warn(`Warning: onStderrChunk sink failed: ${String(err)}`);
      }
    });

    timers.wallClock = setTimeout(() => {
      killFor(RUNNER_WALL_CLOCK_LIMIT_KIND);
    }, policy.wallClockLimitMs);
    scheduleIdleTimer();

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        ...(timeoutKind ? { timeoutKind } : {}),
        ...(timeoutEvidence ? { timeoutEvidence } : {}),
      });
    });

    child.stdin?.on('error', () => {  });
    if (req.input !== undefined) child.stdin?.write(req.input);
    child.stdin?.end();
  });
