import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../control-plane/errors.js';
import { INBOX_ITEM_ADDED_TOPIC, RUN_UPDATED_TOPIC } from '../api/graphql-api/graphql-ws/constants.js';
import {
  RunWatchService,
  WATCH_TOPICS,
  MAX_SERVER_HOLD_MS,
  DEFAULT_SERVER_HOLD_MS,
  clampServerHold,
  type RunStateSource,
  type WatchPubSub,
} from './run-watch.service.js';
import type { RunState } from './task-control-plane-api.service.js';

const tick = (ms = 12) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function gate(runId: string, inboxId = 'i1'): RunState {
  return {
    runId,
    state: 'pending_gate',
    nextAction: 'resolve approval with approve_gate or reject_gate',
    runStatus: 'running',
    workflowStatus: 'PENDING',
    inbox: { id: inboxId } as unknown as RunState['inbox'],
  };
}
const running = (runId: string): RunState => ({
  runId,
  state: 'running',
  nextAction: 'wait_for_run again',
  runStatus: 'running',
  workflowStatus: 'PENDING',
});
const completed = (runId: string): RunState => ({
  runId,
  state: 'completed',
  nextAction: 'none',
  runStatus: 'completed',
  workflowStatus: 'SUCCESS',
});

/** Fake api: a run maps to a fixed RunState, a sequence consumed one-per-resolve, or absent → ROW_NOT_FOUND. */
function fakeApi(opts: {
  states?: Record<string, RunState | RunState[]>;
  runs?: Array<{ runId: string; status: string }>;
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

test('[fix] watch_runs omit-runIds delivers a terminal transition that lands BETWEEN polls', async () => {
  // The omit path builds its set from active runs, so a run that completes between calls has already
  // dropped out — the cursor must re-include it so its terminal transition is still delivered once.
  let status = 'running';
  let state: RunState = running('r1');
  const api: RunStateSource = {
    async resolveRunState() {
      return state;
    },
    async listRuns() {
      return [{ runId: 'r1', status }];
    },
  };
  const svc = new RunWatchService(api);

  const first = await svc.watchRuns({ timeoutMs: 0 }); // omit runIds; r1 running → cursor tracks it
  assert.equal(first.transitions.length, 0);

  status = 'completed';
  state = completed('r1'); // r1 terminates between polls — no longer in the active set
  const second = await svc.watchRuns({ timeoutMs: 0, cursor: first.cursor });
  assert.equal(second.transitions[0]?.state, 'completed', 'between-poll terminal still delivered in omit mode');

  const third = await svc.watchRuns({ timeoutMs: 0, cursor: second.cursor });
  assert.equal(third.transitions.length, 0, 'and then suppressed (delivered once)');
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
