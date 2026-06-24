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
  inbox?: RunState['inbox'];
  latestBlockingEvent?: unknown;
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

/** The minimal read surface RunWatchService needs from TaskControlPlaneApiService (keeps it fakeable). */
export type RunStateSource = {
  resolveRunState(runId: string): Promise<RunState>;
  listRuns(filter?: { status?: string; limit?: number }): Promise<Array<{ runId: string; status: string }>>;
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
const TERMINAL_RUN_STATUS: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
/**
 * Cursor marker for a `running` run: not deliverable (running is never actionable), but recorded so the
 * cursor remembers we were *tracking* this run. The omit-runIds path needs that memory to deliver a
 * run's terminal transition that lands BETWEEN polls — by then the run has left the active set, so only
 * the cursor can tell us it was ours to report. Must differ from every actionable marker below.
 */
const RUNNING_MARKER = '~';

/** The marker a terminal run carries, derived from its run-row status (mirror of markerFor's terminal arms). */
function terminalMarkerForStatus(status: string): string | undefined {
  if (status === 'completed') return 'c';
  if (status === 'failed') return 'f';
  if (status === 'cancelled') return 'b:cancelled'; // resolveRunState maps cancelled → state 'blocked'
  return undefined;
}

/** The topics this watch composes off APP_PUB_SUB — exported so a test can assert sync with constants.js. */
export const WATCH_TOPICS = [INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC] as const;

export function clampServerHold(timeoutMs?: number): number {
  const requested = timeoutMs ?? DEFAULT_SERVER_HOLD_MS;
  if (!Number.isFinite(requested) || requested < 0) return DEFAULT_SERVER_HOLD_MS;
  return Math.min(requested, MAX_SERVER_HOLD_MS);
}

/**
 * The cursor marker for a run's current level. A *changed* marker (vs the caller's cursor) is a new
 * transition worth delivering: a gate is keyed by its inbox id (deterministic per gateKey, so a
 * *different* gate yields a different id), a terminal/blocked run by its status, and a still-`running`
 * run by the non-deliverable RUNNING_MARKER (recorded only so the cursor remembers we tracked it).
 */
function markerFor(state: RunState): string {
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
    case 'running':
      return RUNNING_MARKER;
  }
}

function encodeCursor(markers: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ v: 1, m: markers }), 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: number;
      m?: Record<string, string>;
    };
    if (parsed && parsed.v === 1 && parsed.m && typeof parsed.m === 'object') return parsed.m;
    return {};
  } catch {
    return {};
  }
}

export class RunWatchService {
  constructor(
    private readonly api: RunStateSource,
    private readonly pubSub?: WatchPubSub,
  ) {}

  /** Block until any watched run hits an approval/question gate (or the hold elapses). */
  waitForAnyGate(input: WatchInput): Promise<WatchResult> {
    return this.watch(input, GATE_STATES);
  }

  /** Like waitForAnyGate, but also surfaces terminal (completed/failed) and blocked transitions. */
  watchRuns(input: WatchInput): Promise<WatchResult> {
    return this.watch(input, WATCH_STATES);
  }

  private async watch(input: WatchInput, actionable: ReadonlySet<RunState['state']>): Promise<WatchResult> {
    const prev = decodeCursor(input.cursor);
    const runIds = await this.resolveRunIds(input.runIds, prev);
    const serverHold = clampServerHold(input.timeoutMs);

    // 1. Initial sweep first — deliver anything already actionable (the common "already gated" case
    //    returns instantly) without arming a subscription. A transition that lands AFTER this read but
    //    BEFORE the subscription resolves is not lost: the cursor re-call's next sweep observes it.
    const sweep = await this.sweep(runIds);
    const initial = collectNew(sweep, prev, actionable);
    const cursor0 = mergeCursor(prev, sweep);
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
        if (found.length > 0) settle({ transitions: found, cursor: encodeCursor(mergeCursor(cursor0, states)), timedOut: false });
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

  private async resolveRunIds(provided: string[] | undefined, prev: Record<string, string>): Promise<string[]> {
    if (provided && provided.length > 0) {
      if (provided.length > MAX_RUN_IDS) {
        throw new Error(
          `VALIDATION_FAILURE: watch supports at most ${MAX_RUN_IDS} runIds (received ${provided.length}); narrow the set`,
        );
      }
      return [...new Set(provided)];
    }
    // Omitted → watch every active (non-terminal) run, capped (active first; a gate on any uncapped run
    // still surfaces on the operator's next re-call).
    const runs = await this.api.listRuns({});
    const active = runs.filter((run) => !TERMINAL_RUN_STATUS.has(run.status)).map((run) => run.runId);
    // Plus any run the caller's cursor was already tracking that has since gone terminal but whose
    // terminal marker they have NOT yet seen — so a run that completed/failed BETWEEN polls is still
    // delivered once (watch_runs' contract) even though it has already dropped out of the active set.
    const undeliveredTerminal = runs
      .filter((run) => {
        const terminalMarker = terminalMarkerForStatus(run.status);
        return terminalMarker !== undefined && run.runId in prev && prev[run.runId] !== terminalMarker;
      })
      .map((run) => run.runId);
    return [...new Set([...active, ...undeliveredTerminal])].slice(0, MAX_RUN_IDS);
  }

  private sweep(runIds: string[]): Promise<RunState[]> {
    return Promise.all(
      runIds.map((runId) =>
        this.api.resolveRunState(runId).catch((error: unknown): RunState => {
          if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
            return { runId, state: 'failed', nextAction: 'run not found', runStatus: 'not_found', workflowStatus: '' };
          }
          // A transient read error must not masquerade as a terminal transition; keep waiting.
          return { runId, state: 'running', nextAction: 'transient read error; will retry', runStatus: 'unknown', workflowStatus: '' };
        }),
      ),
    );
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
      inbox: state.inbox,
      latestBlockingEvent: state.latestBlockingEvent,
    });
  }
  return out;
}

function mergeCursor(prev: Record<string, string>, states: RunState[]): Record<string, string> {
  const next = { ...prev };
  for (const state of states) {
    next[state.runId] = markerFor(state);
  }
  return next;
}
