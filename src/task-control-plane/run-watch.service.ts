
import { ControlPlaneError } from '../control-plane/errors.js';
import {
  deriveCanonicalActivitySignal,
  type CanonicalActivityAttemptSignal,
  type CanonicalActivitySignal,
} from '../observability/activity-signal.js';
import type { AgentRunActivity } from '../observability/types.js';
import { INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC } from '../api/graphql-api/graphql-ws/constants.js';
import type { RunState } from './task-control-plane-api.service.js';


export type RunTransition = {
  runId: string;
  state: RunState['state'];
  nextAction: string;
  runStatus: string;
  workflowStatus: string;
  issueRef?: RunState['issueRef'];
  inbox?: RunState['inbox'];
  latestBlockingEvent?: unknown;
  blockedReason?: string;
  latestEventAt?: string;
  latestEventType?: string;
};

export type WatchResult = {
  transitions: RunTransition[];
  cursor: string;
  timedOut: boolean;
};

export type RunAttentionNextAction = 'start_run' | 'wait' | 'ask_human' | 'inspect_digest' | 'inspect_log' | 'done';

export type ObservedInboxSummary = {
  id: string;
  kind: string;
  title: string;
  status: string;
  stepId?: string;
  optionCount: number;
};

export type RunStatusActivitySummary = {
  aggregateStatus: string;
  latestActivityAt: string;
  latestOutputAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
};

export type RunAttentionResult = {
  runId: string;
  state: RunState['state'];
  requiresAttention: boolean;
  nextAction: RunAttentionNextAction;
  issueRef?: RunState['issueRef'];
  inbox?: ObservedInboxSummary;
  blockedReason?: string;
  activeAttempt?: CanonicalActivityAttemptSignal;
  suggestedTools: string[];
};

export type RunStatusResult = {
  runId: string;
  state: RunState['state'];
  runStatus: string;
  workflowStatus: string;
  issueRef?: RunState['issueRef'];
  latestEventAt?: string;
  latestEventType?: string;
  inbox?: ObservedInboxSummary;
  blockedReason?: string;
  activity?: RunStatusActivitySummary;
};

export type WatchRunChangesInput = {
  runId: string;
  cursor?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type RunStateSource = {
  resolveRunState(runId: string): Promise<RunState>;
  listRuns(filter?: { status?: string; limit?: number }): Promise<Array<{ runId: string; status: string }>>;
  getAgentActivity?(runId: string): Promise<AgentRunActivity | null>;
};

export type WatchPubSub = {
  subscribe(triggerName: string, onMessage: (payload: unknown) => void): Promise<number>;
  unsubscribe(subId: number): void;
};

export const MAX_RUN_IDS = 50;

export const MAX_SERVER_HOLD_MS = 45_000;
export const DEFAULT_SERVER_HOLD_MS = 28_000;
const WAKEUP_DEBOUNCE_MS = 75;
const POLL_INTERVAL_MS = 500;
const ACTIVITY_READ_TIMEOUT_MS = 250;

const WATCH_TRANSITION_STATES: ReadonlySet<RunState['state']> = new Set([
  'ready',
  'pending_gate',
  'question',
  'completed',
  'failed',
  'blocked',
  'retrying',
]);
const TERMINAL_RUN_STATUS: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
const REQUIRES_ATTENTION: ReadonlySet<RunAttentionNextAction> = new Set(['start_run', 'ask_human', 'inspect_digest', 'inspect_log']);

const MAX_CURSOR_ENTRIES = 200;
export const MAX_WATCH_CURSOR_CHARS = 8_192;

export const WATCH_TOPICS = [INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC] as const;

export function clampServerHold(timeoutMs?: number): number {
  const requested = timeoutMs ?? DEFAULT_SERVER_HOLD_MS;
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_SERVER_HOLD_MS;
  return Math.min(requested, MAX_SERVER_HOLD_MS);
}


function markerFor(state: RunState): string | null {
  switch (state.state) {
    case 'ready':
      return 'ready';
    case 'pending_gate':
    case 'question':
      return `g:${state.inbox?.id ?? ''}`;
    case 'completed':
      return 'c';
    case 'failed':
      return 'f';
    case 'blocked':
      return `b:${state.runStatus}`;
    case 'retrying':
      return `r:${state.runStatus}:${state.workflowStatus}`;
    case 'running':
      return null;
  }
}

function encodeCursor(markers: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ v: 1, m: markers }), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): Record<string, string> {
  if (!cursor) return {};
  if (cursor.length > MAX_WATCH_CURSOR_CHARS) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: number;
      m?: Record<string, unknown>;
    };
    if (!parsed || parsed.v !== 1 || !parsed.m || typeof parsed.m !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [runId, marker] of Object.entries(parsed.m)) {
      if (typeof marker !== 'string') continue;
      out[runId] = marker;
      if (Object.keys(out).length >= MAX_CURSOR_ENTRIES) break;
    }
    return out;
  } catch {
    return {};
  }
}

type WatchInput = {
  runIds?: string[];
  timeoutMs?: number;
  cursor?: string;
  signal?: AbortSignal;
};

export class RunWatchService {
  constructor(
    private readonly api: RunStateSource,
    private readonly pubSub?: WatchPubSub,
  ) {}

  async getRunAttention(runId: string): Promise<RunAttentionResult> {
    const [state, rawActivity] = await Promise.all([
      this.api.resolveRunState(runId),
      this.readActivitySignal(runId),
    ]);
    const activity = shouldExposeActivitySignal(state, rawActivity) ? rawActivity : undefined;
    const nextAction = deriveRunAttentionNextAction(state, activity);
    const activeAttempt = shouldExposeActiveAttempt(state, activity) ? activity?.attempt : undefined;
    const inbox = compactInbox(state.inbox);
    return {
      runId,
      state: state.state,
      requiresAttention: REQUIRES_ATTENTION.has(nextAction),
      nextAction,
      ...(state.issueRef ? { issueRef: state.issueRef } : {}),
      ...(inbox ? { inbox } : {}),
      ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
      ...(activeAttempt ? { activeAttempt } : {}),
      suggestedTools: suggestedTools(state, activity),
    };
  }

  async getRunStatus(runId: string): Promise<RunStatusResult> {
    const [state, rawActivity] = await Promise.all([
      this.api.resolveRunState(runId),
      this.readActivitySignal(runId),
    ]);
    const activity = shouldExposeActivitySignal(state, rawActivity) ? rawActivity : undefined;
    const inbox = compactInbox(state.inbox);
    const compact = compactActivity(activity);
    return {
      runId,
      state: state.state,
      runStatus: state.runStatus,
      workflowStatus: state.workflowStatus,
      ...(state.issueRef ? { issueRef: state.issueRef } : {}),
      ...(state.latestEventAt ? { latestEventAt: state.latestEventAt } : {}),
      ...(state.latestEventType ? { latestEventType: state.latestEventType } : {}),
      ...(inbox ? { inbox } : {}),
      ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
      ...(compact ? { activity: compact } : {}),
    };
  }

  watchRunChanges(input: WatchRunChangesInput): Promise<WatchResult> {
    return this.watch(
      {
        runIds: [input.runId],
        cursor: input.cursor,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
      },
      WATCH_TRANSITION_STATES,
    );
  }

  private async watch(input: WatchInput, actionable: ReadonlySet<RunState['state']>): Promise<WatchResult> {
    const prev = decodeCursor(input.cursor);
    const runIds = await this.resolveRunIds(input.runIds);
    const serverHold = clampServerHold(input.timeoutMs);

    const sweep = await this.sweep(runIds);
    const initial = collectNew(sweep, prev, actionable);
    const cursor0 = mergeCursor(sweep, actionable);
    if (initial.length > 0) {
      return { transitions: initial, cursor: encodeCursor(cursor0), timedOut: false };
    }
    if (runIds.length === 0 || serverHold <= 0 || input.signal?.aborted) {
      return { transitions: [], cursor: encodeCursor(cursor0), timedOut: true };
    }

    return this.holdForTransition(runIds, prev, actionable, cursor0, serverHold, input.signal);
  }

  private holdForTransition(
    runIds: string[],
    prev: Record<string, string>,
    actionable: ReadonlySet<RunState['state']>,
    cursor0: Record<string, string>,
    serverHold: number,
    signal?: AbortSignal,
  ): Promise<WatchResult> {
    return new Promise<WatchResult>((resolve) => {
      let settled = false;
      const subIds: number[] = [];
      const dirty = new Set<string>();
      const watched = new Set(runIds);
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      let pollTimer: ReturnType<typeof setInterval> | undefined;

      const timeout = (): WatchResult => ({ transitions: [], cursor: encodeCursor(cursor0), timedOut: true });
      const onAbort = (): void => settle(timeout());

      const cleanup = (): void => {
        clearTimeout(holdTimer);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (pollTimer) clearInterval(pollTimer);
        for (const id of subIds) this.pubSub?.unsubscribe(id);
        subIds.length = 0;
        signal?.removeEventListener('abort', onAbort);
      };

      const settle = (result: WatchResult): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      const reSweep = async (): Promise<void> => {
        const ids = dirty.size > 0 ? [...dirty] : runIds;
        dirty.clear();
        let states: RunState[];
        try {
          states = await this.sweep(ids);
        } catch {
          return;
        }
        if (settled) return;
        const found = collectNew(states, prev, actionable);
        if (found.length > 0) {
          settle({ transitions: found, cursor: encodeCursor({ ...cursor0, ...mergeCursor(states, actionable) }), timedOut: false });
        }
      };

      const scheduleReSweep = (): void => {
        if (settled || debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          void reSweep();
        }, WAKEUP_DEBOUNCE_MS);
      };

      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const holdTimer = setTimeout(() => settle(timeout()), serverHold);

      if (this.pubSub) {
        const onMessage = (payload: unknown): void => {
          const rid = (payload as { runId?: string } | null)?.runId;
          if (rid !== undefined && !watched.has(rid)) return;
          if (rid) dirty.add(rid);
          scheduleReSweep();
        };
        for (const topic of WATCH_TOPICS) {
          this.pubSub
            .subscribe(topic, onMessage)
            .then((id) => {
              if (settled) this.pubSub?.unsubscribe(id);
              else subIds.push(id);
            })
            .catch(() => undefined);
        }
      } else {
        pollTimer = setInterval(() => {
          if (!settled) void reSweep();
        }, POLL_INTERVAL_MS);
      }
    });
  }

  private async resolveRunIds(provided: string[] | undefined): Promise<string[]> {
    if (provided && provided.length > 0) {
      if (provided.length > MAX_RUN_IDS) {
        throw new Error(
          `VALIDATION_FAILURE: watch supports at most ${MAX_RUN_IDS} runIds (received ${provided.length}); narrow the set`,
        );
      }
      return [...new Set(provided)];
    }
    const runs = await this.api.listRuns({});
    return runs
      .filter((run) => !TERMINAL_RUN_STATUS.has(run.status))
      .map((run) => run.runId)
      .slice(0, MAX_RUN_IDS);
  }

  private sweep(runIds: string[]): Promise<RunState[]> {
    return Promise.all(runIds.map((runId) => this.resolveRunState(runId)));
  }

  private async resolveRunState(runId: string): Promise<RunState> {
    return this.api.resolveRunState(runId).catch((error: unknown): RunState => {
      if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
        return { runId, state: 'failed', nextAction: 'run not found', runStatus: 'not_found', workflowStatus: '' };
      }
      return { runId, state: 'running', nextAction: 'transient read error; will retry', runStatus: 'unknown', workflowStatus: '' };
    });
  }

  private async readActivitySignal(runId: string): Promise<CanonicalActivitySignal | undefined> {
    if (!this.api.getAgentActivity) return undefined;
    try {
      return deriveCanonicalActivitySignal(
        await withDeadline(this.api.getAgentActivity(runId), ACTIVITY_READ_TIMEOUT_MS),
      );
    } catch {
      return undefined;
    }
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function collectNew(
  states: RunState[],
  prev: Record<string, string>,
  actionable: ReadonlySet<RunState['state']>,
): RunTransition[] {
  const out: RunTransition[] = [];
  for (const state of states) {
    if (!actionable.has(state.state)) continue;
    const marker = markerFor(state);
    if (prev[state.runId] === marker) continue;
    out.push({
      runId: state.runId,
      state: state.state,
      nextAction: state.nextAction,
      runStatus: state.runStatus,
      workflowStatus: state.workflowStatus,
      ...(state.issueRef ? { issueRef: state.issueRef } : {}),
      inbox: state.inbox,
      latestBlockingEvent: state.latestBlockingEvent,
      blockedReason: state.blockedReason,
      latestEventAt: state.latestEventAt,
      latestEventType: state.latestEventType,
    });
  }
  return out;
}

function mergeCursor(states: RunState[], actionable: ReadonlySet<RunState['state']>): Record<string, string> {
  const next: Record<string, string> = {};
  for (const state of states) {
    if (!actionable.has(state.state)) continue;
    const marker = markerFor(state);
    if (marker !== null) next[state.runId] = marker;
  }
  return next;
}

function compactInbox(inbox: RunState['inbox']): ObservedInboxSummary | undefined {
  if (!inbox) return undefined;
  return {
    id: inbox.id,
    kind: inbox.kind,
    title: inbox.title,
    status: inbox.status,
    ...(inbox.stepId ? { stepId: inbox.stepId } : {}),
    optionCount: Array.isArray(inbox.options) ? inbox.options.length : 0,
  };
}

function shouldInspectLog(activity: CanonicalActivitySignal | undefined): boolean {
  const status = activity?.attempt?.status ?? activity?.aggregateStatus;
  return status === 'failed' || status === 'timed_out' || status === 'permission_blocked';
}

function shouldExposeActiveAttempt(
  state: Pick<RunState, 'state'>,
  activity: CanonicalActivitySignal | undefined,
): boolean {
  if (!activity?.attempt) return false;
  return state.state !== 'completed';
}

function shouldExposeActivitySignal(
  state: Pick<RunState, 'state'>,
  activity: CanonicalActivitySignal | undefined,
): boolean {
  if (!activity) return false;
  return state.state !== 'completed';
}

function deriveRunAttentionNextAction(
  state: Pick<RunState, 'state' | 'runStatus'>,
  activity: CanonicalActivitySignal | undefined,
): RunAttentionNextAction {
  switch (state.state) {
    case 'ready':
      return 'start_run';
    case 'pending_gate':
    case 'question':
      return 'ask_human';
    case 'completed':
      return 'done';
    case 'failed':
      return shouldInspectLog(activity) ? 'inspect_log' : 'inspect_digest';
    case 'blocked':
      if (state.runStatus === 'cancelled') return 'done';
      return 'inspect_digest';
    case 'retrying':
    case 'running':
      return 'wait';
  }
}

function compactActivity(activity: CanonicalActivitySignal | undefined): RunStatusActivitySummary | undefined {
  if (!activity) return undefined;
  return {
    aggregateStatus: activity.aggregateStatus,
    latestActivityAt: activity.latestActivityAt,
    ...(activity.latestOutputAt ? { latestOutputAt: activity.latestOutputAt } : {}),
    stdoutBytes: activity.stdoutBytes,
    stderrBytes: activity.stderrBytes,
    eventCount: activity.eventCount,
  };
}

function suggestedTools(state: Pick<RunState, 'state' | 'runStatus'>, activity: CanonicalActivitySignal | undefined): string[] {
  const nextAction = deriveRunAttentionNextAction(state, activity);
  if (nextAction === 'inspect_log') return ['get_agent_log'];
  if (nextAction === 'inspect_digest') return ['get_run_digest'];
  if (nextAction === 'ask_human') return ['get_inbox_item', 'approve_gate', 'reject_gate', 'answer_question'];
  if (nextAction === 'start_run') return ['start_run'];
  return [];
}
