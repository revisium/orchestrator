import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../control-plane/errors.js';
import { INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC } from '../api/graphql-api/graphql-ws/constants.js';
import {
  RunWatchService,
  WATCH_TOPICS,
  MAX_WATCH_CURSOR_CHARS,
  MAX_SERVER_HOLD_MS,
  DEFAULT_SERVER_HOLD_MS,
  DEFAULT_HEARTBEAT_EVERY_MS,
  MAX_HEARTBEAT_EVERY_MS,
  clampServerHold,
  clampHeartbeatEvery,
  type RunStateSource,
  type WatchPubSub,
} from './run-watch.service.js';
import type { RunState } from './task-control-plane-api.service.js';
import type { AgentRunActivity } from '../observability/types.js';

const tick = (ms = 12) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const neverActivity = () => new Promise<AgentRunActivity | null>(() => undefined);

async function resultBeforeDeadline<T>(promise: Promise<T>, ms = 350): Promise<T | 'deadline'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'deadline'>((resolve) => {
        timer = setTimeout(() => resolve('deadline'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function gate(runId: string, inboxId = 'i1'): RunState {
  return {
    runId,
    state: 'pending_gate',
    nextAction: 'resolve approval with approve_gate or reject_gate',
    runStatus: 'running',
    workflowStatus: 'PENDING',
    inbox: inbox({ id: inboxId, kind: 'approval', title: 'Plan approval' }),
  };
}
function inbox(input: { id: string; kind: 'approval' | 'question'; title: string }): RunState['inbox'] {
  return {
    id: input.id,
    kind: input.kind,
    runId: 'r1',
    taskId: 't1',
    stepId: 's1',
    projectId: 'p1',
    title: input.title,
    context: { omitted: true },
    options: input.kind === 'approval' ? ['approve', 'reject'] : [],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-26T10:00:00.000Z',
    resolvedAt: '',
  };
}
function question(runId: string, inboxId = 'q1'): RunState {
  return {
    runId,
    state: 'question',
    nextAction: 'answer question with answer_question',
    runStatus: 'running',
    workflowStatus: 'PENDING',
    inbox: inbox({ id: inboxId, kind: 'question', title: 'Need an answer' }),
  };
}
const running = (runId: string): RunState => ({
  runId,
  state: 'running',
  nextAction: 'wait_for_run again',
  runStatus: 'running',
  workflowStatus: 'PENDING',
});
const ready = (runId: string): RunState => ({
  runId,
  state: 'ready',
  nextAction: 'start_run',
  runStatus: 'ready',
  workflowStatus: '',
});
const completed = (runId: string): RunState => ({
  runId,
  state: 'completed',
  nextAction: 'none',
  runStatus: 'completed',
  workflowStatus: 'SUCCESS',
});
const failed = (runId: string): RunState => ({
  runId,
  state: 'failed',
  nextAction: 'inspect get_run_events/get_run_log',
  runStatus: 'failed',
  workflowStatus: 'ERROR',
});
const blocked = (runId: string): RunState => ({
  runId,
  state: 'blocked',
  nextAction: 'inspect blocking event',
  runStatus: 'paused',
  workflowStatus: 'PENDING',
  blockedReason: 'needs human',
  latestBlockingEvent: {
    eventId: 'event-1',
    type: 'pipeline_blocked',
    createdAt: '2026-06-26T10:00:00.000Z',
    payload: { raw: 'x'.repeat(10_000), secret: 'do not expose' },
  },
});
const retrying = (runId: string): RunState => ({
  runId,
  state: 'retrying',
  nextAction: 'retry is scheduled',
  runStatus: 'running',
  workflowStatus: 'RETRYING',
});

function activity(status: AgentRunActivity['aggregateStatus'] = 'running'): AgentRunActivity {
  return {
    runId: 'r1',
    aggregateStatus: status,
    latestActivityAt: '2026-06-26T10:00:03.000Z',
    latestOutputAt: '2026-06-26T10:00:02.000Z',
    attempts: [{
      runId: 'r1',
      attemptId: 'attempt-1',
      stepId: 'developer',
      role: 'developer',
      runner: 'codex',
      status,
      startedAt: '2026-06-26T10:00:00.000Z',
      lastEventAt: '2026-06-26T10:00:03.000Z',
      lastOutputAt: '2026-06-26T10:00:02.000Z',
      stdoutBytes: 12,
      stderrBytes: status === 'failed' ? 7 : 0,
      eventCount: 3,
      artifactRef: 'r1/attempt-1',
      error: 'raw failure detail must not be exposed',
    }],
  };
}

/** Fake api: a run maps to a fixed RunState, a sequence consumed one-per-resolve, or absent → ROW_NOT_FOUND. */
function fakeApi(opts: {
  states?: Record<string, RunState | RunState[]>;
  runs?: Array<{ runId: string; status: string }>;
  activity?: AgentRunActivity | null | (() => Promise<AgentRunActivity | null>);
}): RunStateSource & { calls: string[] } {
  const calls: string[] = [];
  const idx: Record<string, number> = {};
  return {
    calls,
    async resolveRunState(runId: string): Promise<RunState> {
      calls.push(runId);
      const value = opts.states?.[runId];
      if (Array.isArray(value)) {
        const i = Math.min(idx[runId] ?? 0, value.length - 1);
        idx[runId] = (idx[runId] ?? 0) + 1;
        return value[i];
      }
      if (value) return value;
      throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    },
    async listRuns() {
      return opts.runs ?? [];
    },
    async getAgentActivity() {
      if (typeof opts.activity === 'function') return opts.activity();
      return opts.activity ?? null;
    },
  };
}

function fakePubSub() {
  const state = { subscribeCalls: 0, unsubscribeCalls: 0, handlers: [] as Array<(p: unknown) => void> };
  const pubSub: WatchPubSub = {
    async subscribe(_trigger: string, onMessage: (payload: unknown) => void): Promise<number> {
      state.subscribeCalls += 1;
      state.handlers.push(onMessage);
      return state.subscribeCalls;
    },
    unsubscribe(): void {
      state.unsubscribeCalls += 1;
    },
  };
  return {
    state,
    pubSub,
    fire(payload: unknown): void {
      for (const handler of [...state.handlers]) handler(payload);
    },
  };
}

test('clampServerHold: default, clamp to max, reject negative/NaN', () => {
  assert.equal(clampServerHold(undefined), DEFAULT_SERVER_HOLD_MS);
  assert.equal(clampServerHold(120_000), MAX_SERVER_HOLD_MS);
  assert.equal(clampServerHold(10_000), 10_000);
  assert.equal(clampServerHold(-5), DEFAULT_SERVER_HOLD_MS);
  assert.equal(clampServerHold(Number.NaN), DEFAULT_SERVER_HOLD_MS);
  assert.equal(clampServerHold(0), 0);
});

test('clampHeartbeatEvery: default, clamp to max, reject nonpositive/NaN', () => {
  assert.equal(clampHeartbeatEvery(undefined), DEFAULT_HEARTBEAT_EVERY_MS);
  assert.equal(clampHeartbeatEvery(120_000), MAX_HEARTBEAT_EVERY_MS);
  assert.equal(clampHeartbeatEvery(2_000), 2_000);
  assert.equal(clampHeartbeatEvery(0), DEFAULT_HEARTBEAT_EVERY_MS);
  assert.equal(clampHeartbeatEvery(Number.NaN), DEFAULT_HEARTBEAT_EVERY_MS);
});

test('WATCH_TOPICS composes exactly the inbox-added + run-updated topics', () => {
  assert.deepEqual([...WATCH_TOPICS], [INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC]);
});

test('initial sweep returns an already-gated run immediately, without arming a subscription', async () => {
  const api = fakeApi({ states: { r1: gate('r1') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 5_000 });

  assert.equal(result.timedOut, false);
  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].runId, 'r1');
  assert.equal(result.transitions[0].state, 'pending_gate');
  assert.equal(result.transitions[0].inbox?.id, 'i1');
  assert.equal(ps.state.subscribeCalls, 0, 'no subscription armed when already actionable');
});

test('subscription wakeup resolves on a matching inbox event and tears the subscription down', async () => {
  const api = fakeApi({ states: { r1: [running('r1'), gate('r1')] } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 3_000 });
  await tick(); // let the initial sweep + both subscribe() promises resolve
  assert.equal(ps.state.subscribeCalls, WATCH_TOPICS.length, 'armed one subscription per topic');

  ps.fire({ inboxItemAdded: {}, runId: 'r1' });
  const result = await pending;

  assert.equal(result.timedOut, false);
  assert.equal(result.transitions[0]?.state, 'pending_gate');
  assert.equal(ps.state.unsubscribeCalls, WATCH_TOPICS.length, 'every subscription detached on settle');
});

test('a wakeup for an unwatched run does not resolve the watch', async () => {
  const api = fakeApi({ states: { r1: running('r1') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 60 });
  await tick();
  ps.fire({ inboxItemAdded: {}, runId: 'other' }); // not in the watch set
  const result = await pending;

  assert.equal(result.timedOut, true, 'unwatched runId ignored → falls through to timeout');
});

test('timer expiry returns {timedOut:true} with a resume cursor', async () => {
  const api = fakeApi({ states: { r1: running('r1') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 30 });

  assert.equal(result.timedOut, true);
  assert.deepEqual(result.transitions, []);
  assert.equal(typeof result.cursor, 'string');
  assert.ok(result.cursor.length > 0);
  assert.equal(ps.state.unsubscribeCalls, WATCH_TOPICS.length, 'subscriptions detached on timeout (no leak)');
});

test('cursor makes re-calls idempotent and O(new): same gate suppressed, new gate reported', async () => {
  const api = fakeApi({ states: { r1: gate('r1', 'inbox-A') } });
  const svc = new RunWatchService(api); // poll-fallback; timeoutMs:0 means no hold at all

  const first = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(first.transitions.length, 1, 'first sight of the gate is delivered');

  const second = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: first.cursor });
  assert.equal(second.transitions.length, 0, 'same gate (same inbox id) suppressed by the cursor');
  assert.equal(second.timedOut, true);

  // A genuinely new gate (different inbox id) must be reported even with the old cursor.
  const api2 = fakeApi({ states: { r1: gate('r1', 'inbox-B') } });
  const svc2 = new RunWatchService(api2);
  const third = await svc2.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: first.cursor });
  assert.equal(third.transitions.length, 1, 'a different gate id is a new transition');
});

test('aborting the request (transport close) resolves timedOut and detaches subscriptions', async () => {
  const api = fakeApi({ states: { r1: running('r1') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);
  const ac = new AbortController();

  const pending = svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 10_000, signal: ac.signal });
  await tick();
  ac.abort();
  const result = await pending;

  assert.equal(result.timedOut, true);
  assert.equal(ps.state.unsubscribeCalls, WATCH_TOPICS.length, 'abort tears down the subscription');
});

test('an already-aborted signal returns immediately after the sweep', async () => {
  const api = fakeApi({ states: { r1: running('r1') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);
  const ac = new AbortController();
  ac.abort();

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 10_000, signal: ac.signal });

  assert.equal(result.timedOut, true);
  assert.equal(ps.state.subscribeCalls, 0, 'pre-aborted → never arms');
});

test('watchRuns surfaces a terminal transition that waitForAnyGate ignores', async () => {
  const api = fakeApi({ states: { r1: completed('r1') } });
  const watched = await new RunWatchService(api).watchRuns({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(watched.transitions[0]?.state, 'completed');

  const gateOnly = await new RunWatchService(fakeApi({ states: { r1: completed('r1') } })).waitForAnyGate({
    runIds: ['r1'],
    timeoutMs: 30,
  });
  assert.equal(gateOnly.transitions.length, 0, 'a completed run is not an approval gate');
  assert.equal(gateOnly.timedOut, true);
});

test('poll fallback (no pubSub) still resolves a gate that appears after the initial sweep', async () => {
  const api = fakeApi({ states: { r1: [running('r1'), gate('r1')] } });
  const svc = new RunWatchService(api); // no pubSub → internal poll

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 3_000 });

  assert.equal(result.timedOut, false);
  assert.equal(result.transitions[0]?.state, 'pending_gate');
});

test('omitted runIds watches only active (non-terminal) runs', async () => {
  const api = fakeApi({
    states: { a: gate('a'), b: completed('b') },
    runs: [
      { runId: 'a', status: 'running' },
      { runId: 'b', status: 'completed' },
    ],
  });
  const svc = new RunWatchService(api);

  const result = await svc.waitForAnyGate({ timeoutMs: 0 });

  assert.equal(result.transitions.length, 1);
  assert.equal(result.transitions[0].runId, 'a');
  assert.ok(!api.calls.includes('b'), 'terminal run b is filtered out before resolveRunState');
});

test('too many runIds is rejected before any work', async () => {
  const svc = new RunWatchService(fakeApi({}));
  await assert.rejects(
    () => svc.waitForAnyGate({ runIds: Array.from({ length: 51 }, (_, i) => `r${i}`) }),
    /at most 50 runIds/,
  );
});

test('a not-found run is a failed transition for watchRuns, ignored by waitForAnyGate', async () => {
  const watched = await new RunWatchService(fakeApi({})).watchRuns({ runIds: ['ghost'], timeoutMs: 0 });
  assert.equal(watched.transitions[0]?.state, 'failed');

  const gateOnly = await new RunWatchService(fakeApi({})).waitForAnyGate({ runIds: ['ghost'], timeoutMs: 25 });
  assert.equal(gateOnly.transitions.length, 0);
  assert.equal(gateOnly.timedOut, true);
});

// ── Coverage hardening (adversarial-review findings) ──────────────────────────────────────────────

test('watch_runs with EXPLICIT runIds delivers a between-poll terminal exactly once (the guaranteed path)', async () => {
  // Explicit runIds are always swept regardless of status, so a run that terminates between polls is
  // still delivered. (Omit mode is best-effort — a terminated run drops out of the active set.)
  let state: RunState = running('r1');
  const api: RunStateSource = {
    async resolveRunState() {
      return state;
    },
    async listRuns() {
      return [{ runId: 'r1', status: state.runStatus }];
    },
  };
  const svc = new RunWatchService(api);

  const first = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(first.transitions.length, 0);

  state = completed('r1'); // r1 terminates between polls
  const second = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0, cursor: first.cursor });
  assert.equal(second.transitions[0]?.state, 'completed', 'explicit runIds deliver the terminal transition');

  const third = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0, cursor: second.cursor });
  assert.equal(third.transitions.length, 0, 'and then suppressed (delivered once)');
});

test('[fix D] one tool must not advance the cursor past a transition it did not deliver', async () => {
  // wait_for_any_gate (gate-only) observing a completed run must NOT record marker 'c' — else a later
  // watch_runs call with that cursor would wrongly suppress the (never-delivered) completion.
  const api = fakeApi({ states: { r1: completed('r1') }, runs: [{ runId: 'r1', status: 'completed' }] });
  const svc = new RunWatchService(api);

  const gateCall = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(gateCall.transitions.length, 0, 'completed is not a gate → nothing delivered');

  const watchCall = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0, cursor: gateCall.cursor });
  assert.equal(watchCall.transitions[0]?.state, 'completed', 'watch_runs still delivers it — not suppressed by the gate cursor');
});

test('[fix C] an oversized forged cursor is ignored before decode work and the returned cursor is capped', async () => {
  const api = fakeApi({ states: { r1: gate('r1', 'i1') } });
  const svc = new RunWatchService(api);
  // Oversized cursors must not be decoded/parsed; ignoring them is equivalent to a fresh observation.
  const huge: Record<string, unknown> = { r1: 12345 }; // wrong type for r1 → must be ignored → gate re-delivered
  for (let i = 0; i < 5_000; i++) huge[`junk-${i}`] = 'x';
  const forged = Buffer.from(JSON.stringify({ v: 1, m: huge }), 'utf8').toString('base64url');
  assert.equal(forged.length > MAX_WATCH_CURSOR_CHARS, true, 'test cursor exceeds the service guard');

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: forged });
  assert.equal(result.transitions[0]?.inbox?.id, 'i1', 'oversized cursor ignored → gate delivered');
  // The returned cursor is built from this sweep only — bounded, not the forged entries.
  const decoded = JSON.parse(Buffer.from(result.cursor, 'base64url').toString('utf8')) as { m: Record<string, string> };
  assert.ok(Object.keys(decoded.m).length <= 50, 'returned cursor is bounded to the watched set');
});

test('[leak race] a subscription resolving AFTER the hold settled is still detached', async () => {
  // Deferred subscribe: resolve the subscribe() promises only AFTER the hold has timed out, exercising
  // the `if (settled) unsubscribe(id)` late-detach branch that a synchronous fake never reaches.
  const resolvers: Array<() => void> = [];
  let nextId = 0;
  const counts = { unsubscribe: 0 };
  const pubSub: WatchPubSub = {
    subscribe() {
      return new Promise<number>((resolve) => resolvers.push(() => resolve((nextId += 1))));
    },
    unsubscribe() {
      counts.unsubscribe += 1;
    },
  };
  const svc = new RunWatchService(fakeApi({ states: { r1: running('r1') } }), pubSub);

  const result = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.equal(counts.unsubscribe, 0, 'nothing to detach yet — subscribe() still pending at settle');

  for (const resolve of resolvers) resolve(); // late-arriving subscription ids
  await tick();
  assert.equal(counts.unsubscribe, WATCH_TOPICS.length, 'each late subscription is detached on resolve');
});

test('[integration] a real graphql-subscriptions PubSub wakes the watch on a real-shaped inbox event', async () => {
  const { PubSub } = await import('graphql-subscriptions');
  const pubSub = new PubSub();
  const api = fakeApi({ states: { r1: [running('r1'), gate('r1')] } });
  const svc = new RunWatchService(api, pubSub as unknown as WatchPubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 3_000 });
  await tick(20); // let the real (async) subscribe() register both topics
  await pubSub.publish(INBOX_ITEM_ADDED_TOPIC, { inboxItemAdded: { id: 'i1' }, runId: 'r1' });
  const result = await pending;

  assert.equal(result.transitions[0]?.state, 'pending_gate', 'real PubSub subscribe/publish/runId-filter works');
});

test('[debounce] a burst of wakeups coalesces into a single re-sweep', async () => {
  const api = fakeApi({ states: { r1: running('r1') } }); // stays running → settles via timer, not event
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 250 });
  await tick();
  const afterInitial = api.calls.length;
  for (let i = 0; i < 10; i++) ps.fire({ inboxItemAdded: {}, runId: 'r1' }); // burst within the debounce window
  const result = await pending;

  assert.equal(result.timedOut, true);
  assert.equal(api.calls.length - afterInitial, 1, '10 wakeups collapse to one re-sweep');
});

test('[dirty-set] a wakeup re-sweeps only the changed run, not the whole watch set', async () => {
  const api = fakeApi({ states: { r1: running('r1'), r2: running('r2') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1', 'r2'], timeoutMs: 250 });
  await tick();
  const afterInitial = api.calls.length;
  ps.fire({ inboxItemAdded: {}, runId: 'r1' }); // only r1 dirtied
  const result = await pending;

  assert.equal(result.timedOut, true);
  assert.deepEqual(api.calls.slice(afterInitial), ['r1'], 'only the dirtied run is re-swept');
});

test('[no-runId] a wakeup payload without a runId conservatively re-sweeps the full set', async () => {
  const api = fakeApi({ states: { r1: running('r1'), r2: running('r2') } });
  const ps = fakePubSub();
  const svc = new RunWatchService(api, ps.pubSub);

  const pending = svc.waitForAnyGate({ runIds: ['r1', 'r2'], timeoutMs: 250 });
  await tick();
  const afterInitial = api.calls.length;
  ps.fire({ runUpdated: {} }); // no runId
  const result = await pending;

  assert.equal(result.timedOut, true);
  assert.deepEqual(api.calls.slice(afterInitial).sort(), ['r1', 'r2'], 'unknown wakeup sweeps everything');
});

test('[cursor lineage] one run gate(i1) → running → gate(i2): each new gate reported, old suppressed', async () => {
  let state: RunState = gate('r1', 'i1');
  const api: RunStateSource = {
    async resolveRunState() {
      return state;
    },
    async listRuns() {
      return [{ runId: 'r1', status: 'running' }];
    },
  };
  const svc = new RunWatchService(api);

  const a = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(a.transitions[0]?.inbox?.id, 'i1');

  state = running('r1');
  const b = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: a.cursor });
  assert.equal(b.transitions.length, 0, 'running between gates → nothing');

  state = gate('r1', 'i2');
  const c = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: b.cursor });
  assert.equal(c.transitions[0]?.inbox?.id, 'i2', 'a new gate id is reported across the lineage');

  const d = await svc.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0, cursor: c.cursor });
  assert.equal(d.transitions.length, 0, 're-sighting the same gate is suppressed');
});

test('[cursor lineage] gate then completion both delivered under one advancing cursor (watch_runs)', async () => {
  let state: RunState = gate('r1', 'i1');
  const api: RunStateSource = {
    async resolveRunState() {
      return state;
    },
    async listRuns() {
      return [{ runId: 'r1', status: 'running' }];
    },
  };
  const svc = new RunWatchService(api);

  const a = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0 });
  assert.equal(a.transitions[0]?.state, 'pending_gate');

  state = completed('r1');
  const b = await svc.watchRuns({ runIds: ['r1'], timeoutMs: 0, cursor: a.cursor });
  assert.equal(b.transitions[0]?.state, 'completed', 'the terminal transition follows the gate under one cursor');
});

test('observeRun reports a compact gate transition once under its cursor', async () => {
  const svc = new RunWatchService(fakeApi({ states: { r1: gate('r1', 'gate-1') }, activity: activity() }));

  const first = await svc.observeRun({ runId: 'r1', timeoutMs: 0 });
  const second = await svc.observeRun({ runId: 'r1', timeoutMs: 0, cursor: first.cursor });

  assert.equal(first.state, 'pending_gate');
  assert.equal(first.transition?.state, 'pending_gate');
  assert.equal(first.transition?.nextAction, 'ask_human');
  assert.deepEqual(first.transition?.inbox, {
    id: 'gate-1',
    kind: 'approval',
    title: 'Plan approval',
    status: 'pending',
    stepId: 's1',
    optionCount: 2,
  });
  assert.equal(JSON.stringify(first).includes('context'), false, 'observe_run does not inline full inbox context');
  assert.equal(first.activeAttempt?.attemptId, 'attempt-1');
  assert.equal(second.transition, undefined, 'same gate marker is not re-delivered');
  assert.equal(second.state, 'pending_gate');
  assert.equal(second.nextAction, 'ask_human');
});

test('observeRun returns an actionable transition even when activity enrichment stalls', async () => {
  const svc = new RunWatchService(fakeApi({ states: { r1: gate('r1', 'gate-1') }, activity: neverActivity }));

  const observed = await resultBeforeDeadline(svc.observeRun({ runId: 'r1', timeoutMs: 0 }));
  assert.notEqual(observed, 'deadline', 'observe_run transition must not wait indefinitely for activity');
  if (observed === 'deadline') return;

  assert.equal(observed.state, 'pending_gate');
  assert.equal(observed.transition?.state, 'pending_gate');
  assert.equal(observed.transition?.nextAction, 'ask_human');
  assert.equal(observed.activeAttempt, undefined);
  assert.equal(observed.nextAction, 'ask_human');
});

test('observeRun does not wait for a slow activity enrichment that eventually settles', async () => {
  const slowActivity = () => new Promise<AgentRunActivity | null>((resolve) => {
    const timer = setTimeout(() => resolve(activity()), 500);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  const svc = new RunWatchService(fakeApi({ states: { r1: gate('r1', 'gate-1') }, activity: slowActivity }));
  const startedAt = Date.now();

  const observed = await svc.observeRun({ runId: 'r1', timeoutMs: 0 });

  assert.ok(Date.now() - startedAt < 175, 'lifecycle response must not wait for best-effort activity');
  assert.equal(observed.state, 'pending_gate');
  assert.equal(observed.transition?.nextAction, 'ask_human');
  assert.equal(observed.activeAttempt, undefined);
});

test('observeRun keeps actionable timeout bounded when activity enrichment stalls', async () => {
  const svc = new RunWatchService(fakeApi({ states: { r1: running('r1') }, activity: neverActivity }));

  const observed = await resultBeforeDeadline(svc.observeRun({ runId: 'r1', timeoutMs: 1 }), 700);
  assert.notEqual(observed, 'deadline', 'observe_run timeout path must not wait indefinitely for activity');
  if (observed === 'deadline') return;

  assert.equal(observed.state, 'running');
  assert.equal(observed.timedOut, true);
  assert.equal(observed.transition, undefined);
  assert.equal(observed.activeAttempt, undefined);
  assert.equal(observed.nextAction, 'wait');
});

test('observeRun heartbeat mode returns a heartbeat even when activity enrichment stalls', async () => {
  const svc = new RunWatchService(
    fakeApi({ states: { r1: running('r1') }, activity: neverActivity }),
    undefined,
    () => Date.parse('2026-06-26T10:00:04.000Z'),
  );

  const observed = await resultBeforeDeadline(
    svc.observeRun({ runId: 'r1', mode: 'heartbeat', timeoutMs: 1_000, heartbeatEveryMs: 25 }),
    700,
  );
  assert.notEqual(observed, 'deadline', 'heartbeat must be emitted even when activity is unavailable');
  if (observed === 'deadline') return;

  assert.equal(observed.state, 'running');
  assert.equal(observed.timedOut, true);
  assert.equal(observed.heartbeat?.observedAt, '2026-06-26T10:00:04.000Z');
  assert.equal(observed.heartbeat?.activity, undefined);
  assert.equal(observed.nextAction, 'wait');
});

test('observeRun maps actionable states to canonical next actions', async () => {
  const cases: Array<{
    name: string;
    state: RunState;
    activity?: AgentRunActivity;
    nextAction: string;
    transitionState: RunState['state'];
  }> = [
    { name: 'ready', state: ready('r1'), nextAction: 'start_run', transitionState: 'ready' },
    { name: 'question', state: question('r1'), nextAction: 'ask_human', transitionState: 'question' },
    { name: 'blocked', state: blocked('r1'), nextAction: 'inspect_digest', transitionState: 'blocked' },
    { name: 'failed', state: failed('r1'), activity: activity('failed'), nextAction: 'inspect_log', transitionState: 'failed' },
    { name: 'completed', state: completed('r1'), nextAction: 'done', transitionState: 'completed' },
    { name: 'cancelled', state: { ...blocked('r1'), runStatus: 'cancelled' }, nextAction: 'done', transitionState: 'blocked' },
    { name: 'retrying', state: retrying('r1'), nextAction: 'wait', transitionState: 'retrying' },
  ];

  for (const item of cases) {
    const svc = new RunWatchService(fakeApi({ states: { r1: item.state }, activity: item.activity ?? null }));
    const result = await svc.observeRun({ runId: 'r1', timeoutMs: 0 });

    assert.equal(result.transition?.state, item.transitionState, item.name);
    assert.equal(result.nextAction, item.nextAction, item.name);
    assert.equal(result.transition?.nextAction, item.nextAction, item.name);
  }
});

test('observeRun omits stale activeAttempt on completed terminal states', async () => {
  const svc = new RunWatchService(fakeApi({ states: { r1: completed('r1') }, activity: activity('permission_blocked') }));

  const result = await svc.observeRun({ runId: 'r1', timeoutMs: 0 });

  assert.equal(result.state, 'completed');
  assert.equal(result.nextAction, 'done');
  assert.equal(result.transition?.state, 'completed');
  assert.equal(result.activeAttempt, undefined);
});

test('observeRun heartbeat suppresses stale agent activity on completed terminal states', async () => {
  const svc = new RunWatchService(
    fakeApi({ states: { r1: completed('r1') }, activity: activity('permission_blocked') }),
    undefined,
    () => Date.parse('2026-06-26T10:00:04.000Z'),
  );

  const result = await svc.observeRun({ runId: 'r1', mode: 'heartbeat', timeoutMs: 0 });

  assert.equal(result.state, 'completed');
  assert.equal(result.nextAction, 'done');
  assert.equal(result.heartbeat?.workflow.runStatus, 'completed');
  assert.equal(result.heartbeat?.activity, undefined);
});

test('observeRun heartbeat mode returns on heartbeat cadence with the canonical activity signal', async () => {
  const svc = new RunWatchService(
    fakeApi({ states: { r1: running('r1') }, activity: activity() }),
    undefined,
    () => Date.parse('2026-06-26T10:00:04.000Z'),
  );
  const startedAt = Date.now();

  const result = await svc.observeRun({
    runId: 'r1',
    mode: 'heartbeat',
    timeoutMs: 1_000,
    heartbeatEveryMs: 25,
  });

  assert.equal(result.state, 'running');
  assert.equal(result.timedOut, true);
  assert.equal(result.transition, undefined);
  assert.equal(result.nextAction, 'wait');
  assert.equal(result.heartbeat?.observedAt, '2026-06-26T10:00:04.000Z');
  assert.equal(result.heartbeat?.activity?.latestActivityAt, '2026-06-26T10:00:03.000Z');
  assert.ok(Date.now() - startedAt < 500, 'heartbeat cadence, not timeoutMs, bounds the hold');
});

test('observeRun heartbeat mode includes workflow pulse without agent activity', async () => {
  const svc = new RunWatchService(
    fakeApi({
      states: {
        r1: {
          ...running('r1'),
          latestEventAt: '2026-06-26T10:00:05.000Z',
          latestEventType: 'pr_polled',
        },
      },
      activity: null,
    }),
    undefined,
    () => Date.parse('2026-06-26T10:00:06.000Z'),
  );

  const result = await svc.observeRun({
    runId: 'r1',
    mode: 'heartbeat',
    timeoutMs: 1_000,
    heartbeatEveryMs: 25,
  });

  assert.equal(result.state, 'running');
  assert.equal(result.heartbeat?.activity, undefined);
  assert.deepEqual(result.heartbeat?.workflow, {
    runStatus: 'running',
    workflowStatus: 'PENDING',
    latestEventAt: '2026-06-26T10:00:05.000Z',
    latestEventType: 'pr_polled',
  });
});

test('observeRun diagnostic mode stays bounded and omits raw event payloads', async () => {
  const svc = new RunWatchService(fakeApi({ states: { r1: blocked('r1') }, activity: activity() }));

  const result = await svc.observeRun({ runId: 'r1', mode: 'diagnostic', timeoutMs: 0 });
  const serialized = JSON.stringify(result);

  assert.equal(result.state, 'blocked');
  assert.equal(result.nextAction, 'inspect_digest');
  assert.equal(result.diagnostic?.latestBlockingEvent?.type, 'pipeline_blocked');
  assert.equal(result.diagnostic?.suggestedTools.includes('get_run_digest'), true);
  assert.equal(serialized.includes('do not expose'), false);
  assert.equal(serialized.includes('"payload"'), false);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 4_096, 'diagnostic observe response remains compact');
});
