/**
 * RunWatchService — bounded long-poll watch primitive over many runs (slice 141 D2).
 *
 * The MCP HTTP transport is stateless-per-request with a request timeout (see McpHttpService): no
 * session, no held async-iterator, no server-initiated SSE survives one POST. So we cannot "subscribe
 * over MCP"; instead we convert the daemon's existing in-process push (APP_PUB_SUB) into a bounded
 * long-poll that RETURNS UNDER THE BRIDGE TIMEOUT with a resume cursor.
 *
 * Correctness rests on the SWEEP + CURSOR, not the push. The push (option A) only lowers latency; a
 * pure poll (option B, no pubSub) is an equivalent-correctness degrade. Delivery is **at-least-once +
 * idempotent**: `resolveRunState` is a point-in-time LEVEL read (a gate is `inbox.find(approval)`, not
 * an event edge), so the cursor is a per-run *marker* watermark — a re-call suppresses a run whose
 * actionable level it already delivered, and reports it again only when the marker changes (a new gate
 * id, or a status transition). Approving the same gate twice is already guarded downstream.
 */
import { ControlPlaneError } from '../control-plane/errors.js';
import {
  deriveCanonicalActivitySignal,
  type CanonicalActivityAttemptSignal,
  type CanonicalActivitySignal,
} from '../observability/activity-signal.js';
import type { AgentRunActivity } from '../observability/types.js';
// Single source of truth for the topic names (a zero-import leaf module, so no import cycle). The
// ControlPlaneSubscriptionBridge publishes these from the Postgres LISTEN feed, each payload carrying
// `runId` — the field we filter wakeups on.
import { INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC } from '../api/graphql-api/graphql-ws/constants.js';
import type { RunState } from './task-control-plane-api.service.js';

/** A run that became actionable since the caller's cursor. `inbox` is the same row D3 enriches. */
export type RunTransition = {
  runId: string;
  state: RunState['state'];
  nextAction: string;
  runStatus: string;
  workflowStatus: string;
  inbox?: RunState['inbox'];
  latestBlockingEvent?: unknown;
  blockedReason?: string;
};

export type WatchResult = {
  transitions: RunTransition[];
  cursor: string;
  timedOut: boolean;
};

export type WatchInput = {
  runIds?: string[];
  timeoutMs?: number;
  cursor?: string;
  signal?: AbortSignal;
};

export type ObserveRunMode = 'actionable' | 'heartbeat' | 'diagnostic';
export type ObserveRunNextAction = 'wait' | 'ask_human' | 'inspect_digest' | 'inspect_log' | 'done';

export type ObserveRunInput = {
  runId: string;
  cursor?: string;
  mode?: ObserveRunMode;
  timeoutMs?: number;
  heartbeatEveryMs?: number;
  signal?: AbortSignal;
};

export type ObservedInboxSummary = {
  id: string;
  kind: string;
  title: string;
  status: string;
  stepId?: string;
  optionCount: number;
};

export type ObserveRunTransition = {
  runId: string;
  state: RunState['state'];
  nextAction: ObserveRunNextAction;
  inbox?: ObservedInboxSummary;
  blockedReason?: string;
};

export type ObserveRunActivitySignal = {
  aggregateStatus: string;
  latestActivityAt: string;
  latestOutputAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
  eventCount: number;
};

export type ObserveRunHeartbeat = {
  observedAt: string;
  activity?: ObserveRunActivitySignal;
};

export type ObserveRunDiagnostic = {
  runStatus: string;
  workflowStatus: string;
  blockedReason?: string;
  latestBlockingEvent?: {
    eventId?: string;
    type?: string;
    createdAt?: string;
  };
  activity?: ObserveRunActivitySignal;
  suggestedTools: string[];
};

export type ObserveRunResult = {
  runId: string;
  cursor: string;
  state: RunState['state'];
  timedOut: boolean;
  transition?: ObserveRunTransition;
  activeAttempt?: CanonicalActivityAttemptSignal;
  heartbeat?: ObserveRunHeartbeat;
  nextAction: ObserveRunNextAction;
  diagnostic?: ObserveRunDiagnostic;
};

/** The minimal read surface RunWatchService needs from TaskControlPlaneApiService (keeps it fakeable). */
export type RunStateSource = {
  resolveRunState(runId: string): Promise<RunState>;
  listRuns(filter?: { status?: string; limit?: number }): Promise<Array<{ runId: string; status: string }>>;
  getAgentActivity?(runId: string): Promise<AgentRunActivity | null>;
};

/** The minimal slice of graphql-subscriptions' PubSub we use (subscribe/unsubscribe, no async-iterator). */
export type WatchPubSub = {
  subscribe(triggerName: string, onMessage: (payload: unknown) => void): Promise<number>;
  unsubscribe(subId: number): void;
};

export const MAX_RUN_IDS = 50;
/** Below the SDK inner-hop default of 60000ms with margin for two serial hops + the sweep itself. */
export const MAX_SERVER_HOLD_MS = 45_000;
export const DEFAULT_SERVER_HOLD_MS = 28_000;
const WAKEUP_DEBOUNCE_MS = 75;
const POLL_INTERVAL_MS = 500;

const GATE_STATES: ReadonlySet<RunState['state']> = new Set(['pending_gate', 'question']);
const WATCH_STATES: ReadonlySet<RunState['state']> = new Set([
  'pending_gate',
  'question',
  'completed',
  'failed',
  'blocked',
]);
const OBSERVE_TRANSITION_STATES: ReadonlySet<RunState['state']> = new Set([
  'pending_gate',
  'question',
  'completed',
  'failed',
  'blocked',
  'retrying',
]);
const TERMINAL_RUN_STATUS: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
/** Defensive cap on caller-supplied cursor size (a legitimate cursor only carries the watched runs, ≤ MAX_RUN_IDS). */
const MAX_CURSOR_ENTRIES = 200;
export const MAX_WATCH_CURSOR_CHARS = 8_192;
export const DEFAULT_HEARTBEAT_EVERY_MS = 5_000;
export const MAX_HEARTBEAT_EVERY_MS = MAX_SERVER_HOLD_MS;

/** The topics this watch composes off APP_PUB_SUB — exported so a test can assert sync with constants.js. */
export const WATCH_TOPICS = [INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC] as const;

export function clampServerHold(timeoutMs?: number): number {
  const requested = timeoutMs ?? DEFAULT_SERVER_HOLD_MS;
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_SERVER_HOLD_MS;
  return Math.min(requested, MAX_SERVER_HOLD_MS);
}

export function clampHeartbeatEvery(heartbeatEveryMs?: number): number {
  const requested = heartbeatEveryMs ?? DEFAULT_HEARTBEAT_EVERY_MS;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_HEARTBEAT_EVERY_MS;
  return Math.min(requested, MAX_HEARTBEAT_EVERY_MS);
}

/**
 * The cursor marker for an *actionable* run level. A *changed* marker (vs the caller's cursor) is a new
 * transition worth delivering: a gate is keyed by its inbox id (deterministic per gateKey, so a
 * *different* gate yields a different id), a terminal/blocked run by its status. `running` is not
 * actionable and is never recorded — `null`.
 */
function markerFor(state: RunState): string | null {
  switch (state.state) {
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
    // Keep only well-formed string markers, capped — a forged/oversized cursor can't force unbounded work.
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

export class RunWatchService {
  constructor(
    private readonly api: RunStateSource,
    private readonly pubSub?: WatchPubSub,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Block until any watched run hits an approval/question gate (or the hold elapses). */
  waitForAnyGate(input: WatchInput): Promise<WatchResult> {
    return this.watch(input, GATE_STATES);
  }

  /** Like waitForAnyGate, but also surfaces terminal (completed/failed) and blocked transitions. */
  watchRuns(input: WatchInput): Promise<WatchResult> {
    return this.watch(input, WATCH_STATES);
  }

  async observeRun(input: ObserveRunInput): Promise<ObserveRunResult> {
    const mode = input.mode ?? 'actionable';
    const timeoutMs = mode === 'heartbeat'
      ? Math.min(clampServerHold(input.timeoutMs), clampHeartbeatEvery(input.heartbeatEveryMs))
      : clampServerHold(input.timeoutMs);
    const watched = await this.watch(
      {
        runIds: [input.runId],
        cursor: input.cursor,
        timeoutMs,
        signal: input.signal,
      },
      OBSERVE_TRANSITION_STATES,
    );
    const transition = watched.transitions[0];
    const state = transition ?? await this.resolveRunState(input.runId);
    const activity = await this.readActivitySignal(input.runId);
    const nextAction = observeNextAction(state, activity);
    const heartbeat = mode === 'heartbeat' || mode === 'diagnostic'
      ? observeHeartbeat(activity, this.now)
      : undefined;

    return {
      runId: input.runId,
      cursor: watched.cursor,
      state: state.state,
      timedOut: watched.timedOut,
      ...(transition ? { transition: observeTransition(transition, activity) } : {}),
      ...(activity?.attempt ? { activeAttempt: activity.attempt } : {}),
      ...(heartbeat ? { heartbeat } : {}),
      nextAction,
      ...(mode === 'diagnostic' ? { diagnostic: observeDiagnostic(state, activity) } : {}),
    };
  }

  private async watch(input: WatchInput, actionable: ReadonlySet<RunState['state']>): Promise<WatchResult> {
    const prev = decodeCursor(input.cursor);
    const runIds = await this.resolveRunIds(input.runIds);
    const serverHold = clampServerHold(input.timeoutMs);

    // 1. Initial sweep first — deliver anything already actionable (the common "already gated" case
    //    returns instantly) without arming a subscription. A transition that lands AFTER this read but
    //    BEFORE the subscription resolves is not lost: the cursor re-call's next sweep observes it.
    const sweep = await this.sweep(runIds);
    const initial = collectNew(sweep, prev, actionable);
    const cursor0 = mergeCursor(sweep, actionable);
    if (initial.length > 0) {
      return { transitions: initial, cursor: encodeCursor(cursor0), timedOut: false };
    }
    if (runIds.length === 0 || serverHold <= 0 || input.signal?.aborted) {
      return { transitions: [], cursor: encodeCursor(cursor0), timedOut: true };
    }

    // 2. Nothing actionable yet → hold this single request open for the next transition.
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
        // Detach the pubsub subscription — a held-open request that is torn down (abort/timeout) must
        // not leak a subscriber on the long-lived APP_PUB_SUB.
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
          return; // transient; a later wakeup/poll retries
        }
        if (settled) return;
        const found = collectNew(states, prev, actionable);
        // Merge the re-swept (dirty) runs' markers over this call's initial cursor so the other watched
        // runs keep theirs; still this-call-only (no cross-call carry-forward → bounded).
        if (found.length > 0) {
          settle({ transitions: found, cursor: encodeCursor({ ...cursor0, ...mergeCursor(states, actionable) }), timedOut: false });
        }
      };

      // Coalesce a burst of wakeups into one re-sweep per tick (each sweep is ~4 control-plane reads/run).
      const scheduleReSweep = (): void => {
        if (settled || debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = undefined;
          void reSweep();
        }, WAKEUP_DEBOUNCE_MS);
      };

      // res.on('close') in McpHttpService aborts extra.signal mid-handler (SDK protocol _onclose).
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const holdTimer = setTimeout(() => settle(timeout()), serverHold);

      if (this.pubSub) {
        const onMessage = (payload: unknown): void => {
          const rid = (payload as { runId?: string } | null)?.runId;
          if (rid !== undefined && !watched.has(rid)) return; // not one of ours
          if (rid) dirty.add(rid);
          scheduleReSweep();
        };
        for (const topic of WATCH_TOPICS) {
          this.pubSub
            .subscribe(topic, onMessage)
            .then((id) => {
              // The hold may have settled (timer/abort) before subscribe resolved — detach immediately.
              if (settled) this.pubSub?.unsubscribe(id);
              else subIds.push(id);
            })
            .catch(() => undefined);
        }
      } else {
        // Option B: no push source → poll. Same sweep+cursor correctness, latency rises by one interval.
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
    // Omitted → watch every active (non-terminal) run, capped. A run that terminates between polls drops
    // out of this set, so omit-mode is best-effort for terminal transitions — pass explicit runIds for
    // guaranteed terminal delivery (those are always swept regardless of status).
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
      // A transient read error must not masquerade as a terminal transition; keep waiting.
      return { runId, state: 'running', nextAction: 'transient read error; will retry', runStatus: 'unknown', workflowStatus: '' };
    });
  }

  private async readActivitySignal(runId: string): Promise<CanonicalActivitySignal | undefined> {
    if (!this.api.getAgentActivity) return undefined;
    try {
      return deriveCanonicalActivitySignal(await this.api.getAgentActivity(runId));
    } catch {
      return undefined;
    }
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
      inbox: state.inbox,
      latestBlockingEvent: state.latestBlockingEvent,
      blockedReason: state.blockedReason,
    });
  }
  return out;
}

/**
 * Build the next cursor from THIS sweep only — no carry-forward of prior keys, so it never grows beyond
 * the watched set (bounds it at ≤ MAX_RUN_IDS). Records a marker only for states actionable in the
 * CURRENT mode: a tool must not advance the cursor past a transition it did not deliver (else a later
 * call in the other mode — e.g. watch_runs after wait_for_any_gate saw a `completed` run — would
 * wrongly suppress it). `running` and other non-actionable states carry no marker.
 */
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

function observeNextAction(
  state: Pick<RunState, 'state'>,
  activity: CanonicalActivitySignal | undefined,
): ObserveRunNextAction {
  switch (state.state) {
    case 'pending_gate':
    case 'question':
      return 'ask_human';
    case 'completed':
      return 'done';
    case 'failed':
      return shouldInspectLog(activity) ? 'inspect_log' : 'inspect_digest';
    case 'blocked':
      return 'inspect_digest';
    case 'retrying':
    case 'running':
      return 'wait';
  }
}

function observeTransition(
  state: RunTransition,
  activity: CanonicalActivitySignal | undefined,
): ObserveRunTransition {
  const inbox = compactInbox(state.inbox);
  return {
    runId: state.runId,
    state: state.state,
    nextAction: observeNextAction(state, activity),
    ...(inbox ? { inbox } : {}),
    ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
  };
}

function observeHeartbeat(
  activity: CanonicalActivitySignal | undefined,
  now: () => number,
): ObserveRunHeartbeat {
  const compact = compactActivity(activity);
  return {
    observedAt: new Date(now()).toISOString(),
    ...(compact ? { activity: compact } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactBlockingEvent(event: unknown): ObserveRunDiagnostic['latestBlockingEvent'] | undefined {
  const record = asRecord(event);
  if (!record) return undefined;
  return {
    ...(typeof record.eventId === 'string' ? { eventId: record.eventId } : {}),
    ...(typeof record.type === 'string' ? { type: record.type } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
  };
}

function compactActivity(activity: CanonicalActivitySignal | undefined): ObserveRunActivitySignal | undefined {
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

function suggestedTools(state: Pick<RunState, 'state'>, activity: CanonicalActivitySignal | undefined): string[] {
  const nextAction = observeNextAction(state, activity);
  if (nextAction === 'inspect_log') return ['get_agent_log'];
  if (nextAction === 'inspect_digest') return ['get_run_digest'];
  if (nextAction === 'ask_human') return ['get_inbox_item', 'approve_gate', 'reject_gate', 'answer_question'];
  return [];
}

function observeDiagnostic(
  state: Pick<RunState, 'state' | 'runStatus' | 'workflowStatus' | 'blockedReason' | 'latestBlockingEvent'>,
  activity: CanonicalActivitySignal | undefined,
): ObserveRunDiagnostic {
  const latestBlockingEvent = compactBlockingEvent(state.latestBlockingEvent);
  const compact = compactActivity(activity);
  return {
    runStatus: state.runStatus,
    workflowStatus: state.workflowStatus,
    ...(state.blockedReason ? { blockedReason: state.blockedReason } : {}),
    ...(latestBlockingEvent ? { latestBlockingEvent } : {}),
    ...(compact ? { activity: compact } : {}),
    suggestedTools: suggestedTools(state, activity),
  };
}
