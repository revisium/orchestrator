import type { AgentActivitySnapshot, AgentActivityStatus, AgentRunActivity } from './types.js';

export type RunnerActivityKind = 'stdout' | 'stderr' | 'event' | 'heartbeat' | 'operation';

export type RunnerActivityTrackerSnapshot = {
  startedAt: number;
  lastActivityAt: number;
  inFlightOperationCount: number;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
};

export type RunnerActivityTracker = {
  markActivity(kind: RunnerActivityKind): void;
  recordOutput(stream: 'stdout' | 'stderr', bytes: number): void;
  operationStarted(id: string): void;
  operationFinished(id: string): void;
  snapshot(): RunnerActivityTrackerSnapshot;
};

export type RunnerActivityTrackerOptions = {
  now?: () => number;
  startedAt?: number;
  onChange?: (snapshot: RunnerActivityTrackerSnapshot) => void;
};

export type CanonicalActivityAttemptSignal = {
  attemptId: string;
  stepId: string;
  stepKey?: string;
  role: string;
  runner: string;
  status: AgentActivityStatus;
  startedAt: string;
  lastEventAt: string;
  lastOutputAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
};

export type CanonicalActivitySignal = {
  aggregateStatus: AgentActivityStatus;
  latestActivityAt: string;
  latestOutputAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
  attempt?: CanonicalActivityAttemptSignal;
};

function timeMs(value?: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function attemptSortTime(attempt: AgentActivitySnapshot): number {
  return Math.max(timeMs(attempt.startedAt), timeMs(attempt.lastEventAt), timeMs(attempt.lastOutputAt));
}

function latestAttempt(attempts: AgentActivitySnapshot[]): AgentActivitySnapshot | undefined {
  let selected: AgentActivitySnapshot | undefined;
  for (const attempt of attempts) {
    if (!selected) {
      selected = attempt;
      continue;
    }
    const diff = attemptSortTime(attempt) - attemptSortTime(selected);
    if (diff > 0 || (diff === 0 && attempt.attemptId.localeCompare(selected.attemptId) > 0)) {
      selected = attempt;
    }
  }
  return selected;
}

function mapAttempt(attempt: AgentActivitySnapshot): CanonicalActivityAttemptSignal {
  return {
    attemptId: attempt.attemptId,
    stepId: attempt.stepId,
    ...(attempt.stepKey === undefined ? {} : { stepKey: attempt.stepKey }),
    role: attempt.role,
    runner: attempt.runner,
    status: attempt.status,
    startedAt: attempt.startedAt,
    lastEventAt: attempt.lastEventAt,
    ...(attempt.lastOutputAt === undefined ? {} : { lastOutputAt: attempt.lastOutputAt }),
    stdoutBytes: attempt.stdoutBytes,
    stderrBytes: attempt.stderrBytes,
    eventCount: attempt.eventCount,
  };
}

export function createRunnerActivityTracker(
  opts: RunnerActivityTrackerOptions = {},
): RunnerActivityTracker {
  const now = opts.now ?? (() => Date.now());
  const startedAt = opts.startedAt ?? now();
  const inFlightOperationIds = new Set<string>();
  const snapshot: RunnerActivityTrackerSnapshot = {
    startedAt,
    lastActivityAt: startedAt,
    inFlightOperationCount: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    eventCount: 0,
  };

  function changed(): void {
    snapshot.inFlightOperationCount = inFlightOperationIds.size;
    opts.onChange?.({ ...snapshot });
  }

  function markActivity(kind: RunnerActivityKind): void {
    snapshot.lastActivityAt = now();
    if (kind === 'event' || kind === 'heartbeat') snapshot.eventCount += 1;
    changed();
  }

  return {
    markActivity,

    recordOutput(stream, bytes): void {
      if (stream === 'stdout') snapshot.stdoutBytes += bytes;
      else snapshot.stderrBytes += bytes;
      markActivity(stream);
    },

    operationStarted(id): void {
      if (id.trim().length > 0) inFlightOperationIds.add(id);
      markActivity('operation');
    },

    operationFinished(id): void {
      if (id.trim().length > 0) inFlightOperationIds.delete(id);
      markActivity('operation');
    },

    snapshot(): RunnerActivityTrackerSnapshot {
      return { ...snapshot, inFlightOperationCount: inFlightOperationIds.size };
    },
  };
}

/**
 * Canonical low-context activity signal shared by observe_run and future idle-timeout policy work.
 * This normalizes timestamps and counters only; it intentionally does not decide whether a run is idle.
 */
export function deriveCanonicalActivitySignal(
  activity: AgentRunActivity | null | undefined,
): CanonicalActivitySignal | undefined {
  if (!activity) return undefined;
  const attempt = latestAttempt(activity.attempts);
  const totals = activity.attempts.reduce(
    (acc, item) => ({
      stdoutBytes: acc.stdoutBytes + item.stdoutBytes,
      stderrBytes: acc.stderrBytes + item.stderrBytes,
      eventCount: acc.eventCount + item.eventCount,
    }),
    { stdoutBytes: 0, stderrBytes: 0, eventCount: 0 },
  );
  return {
    aggregateStatus: activity.aggregateStatus,
    latestActivityAt: activity.latestActivityAt,
    ...(activity.latestOutputAt === undefined ? {} : { latestOutputAt: activity.latestOutputAt }),
    ...totals,
    ...(attempt ? { attempt: mapAttempt(attempt) } : {}),
  };
}
