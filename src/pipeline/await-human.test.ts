/**
 * await-human.test.ts — Unit tests for makeAwaitHuman (0004, §5).
 *
 * All tests use the REAL makeAwaitHuman builder (C1 pattern — no local copy).
 * Fakes replace the three injected deps: pushInbox, awaitDecision, appendEvent.
 *
 * Coverage:
 *  - A1: pushInbox called with deterministic id; gate_opened event emitted; resolves to decision.
 *  - A2: awaitDecision returns null → awaitHuman returns fail-closed reject (E7).
 *  - A3 (G11): replay — fake pushInbox returns SAME deterministic id on 2nd call (models
 *    the real ROW_CONFLICT-catch-and-continue inside pushInbox); awaitHuman does NOT throw
 *    and proceeds idempotently to awaitDecision.
 *  - Deterministic id format: `inbox_${fnv1a64Hex(`${runId}|${topic}`)}`.
 *  - No @dbos-inc import needed (DBOS-free, injected deps).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAwaitHuman, type Decision, type AwaitHumanDeps } from './await-human.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { NewInboxItem } from '../control-plane/inbox.js';
import type { AppendEventInput } from '../run/append-event.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDeps(opts: {
  decision?: Decision | null;
  pushInboxResult?: string;
}): {
  deps: AwaitHumanDeps;
  pushInboxCalls: Array<{ item: NewInboxItem; id: string }>;
  appendEventCalls: AppendEventInput[];
  awaitDecisionTopics: string[];
} {
  const pushInboxCalls: Array<{ item: NewInboxItem; id: string }> = [];
  const appendEventCalls: AppendEventInput[] = [];
  const awaitDecisionTopics: string[] = [];

  const deps: AwaitHumanDeps = {
    pushInbox: async (item: NewInboxItem, id: string) => {
      pushInboxCalls.push({ item, id });
      return opts.pushInboxResult ?? id;
    },
    awaitDecision: async <T>(topic: string): Promise<T | null> => {
      awaitDecisionTopics.push(topic);
      return opts.decision as T | null;
    },
    appendEvent: async (input: AppendEventInput): Promise<void> => {
      appendEventCalls.push(input);
    },
  };

  return { deps, pushInboxCalls, appendEventCalls, awaitDecisionTopics };
}

// ─── A1: happy path ───────────────────────────────────────────────────────────

test('A1: awaitHuman pushes inbox with deterministic id, emits gate_opened, returns decision', async () => {
  const runId = 'run-ah-a1';
  const topic = 'plan' as const;
  const approveDecision: Decision = { decision: 'approve' };
  const { deps, pushInboxCalls, appendEventCalls, awaitDecisionTopics } = makeDeps({
    decision: approveDecision,
  });

  const awaitHuman = makeAwaitHuman(deps);
  const result = await awaitHuman(runId, topic, topic, 'Plan approval', { phase: 'plan' });

  // Decision returned correctly.
  assert.equal(result.decision, 'approve');

  // pushInbox called once with kind:'approval', deterministic id, no stepId.
  assert.equal(pushInboxCalls.length, 1, 'pushInbox must be called once');
  const call = pushInboxCalls[0];
  assert.ok(call);
  assert.equal(call.item.kind, 'approval');
  assert.equal(call.item.runId, runId);
  assert.ok(!call.item.stepId, 'gate rows must NOT carry a stepId');

  // context carries topic.
  const ctx = call.item.context as Record<string, unknown>;
  assert.equal(ctx.topic, topic, 'context.topic must match the gate topic');
  assert.deepEqual(call.item.options, ['approve', 'reject'], 'legacy gates keep compatibility options');

  // Deterministic id: inbox_ + 16 hex = 22 chars.
  const expectedId = `inbox_${fnv1a64Hex(`${runId}|${topic}`)}`;
  assert.equal(call.id, expectedId, `inbox id must be deterministic: ${expectedId}`);
  assert.equal(call.id.length, 22, 'inbox id must be 22 chars (≤64)');

  // gate_opened event emitted.
  assert.equal(appendEventCalls.length, 1, 'one gate_opened event must be emitted');
  const evt = appendEventCalls[0];
  assert.ok(evt);
  assert.equal(evt.type, 'gate_opened');
  assert.equal(evt.stepKey, 'gate:plan');
  assert.equal(evt.taskId, '', 'gate events use empty taskId (E14)');
  assert.equal(evt.stepId, '', 'gate events use empty stepId (E14)');

  // awaitDecision called with the topic.
  assert.equal(awaitDecisionTopics.length, 1);
  assert.equal(awaitDecisionTopics[0], topic);
});

test('A1b: awaitHuman exposes named gate outcomes as inbox options', async () => {
  const { deps, pushInboxCalls } = makeDeps({ decision: { outcome: 'recheck' } });
  const awaitHuman = makeAwaitHuman(deps);

  const result = await awaitHuman('run-ah-outcomes', 'merge', 'merge-1', 'Merge approval', {
    nodeId: 'mergeGate',
    outcomes: ['approved', 'recheck'],
  });

  assert.equal(result.outcome, 'recheck');
  assert.deepEqual(pushInboxCalls[0]?.item.options, ['approved', 'recheck']);
});

test('A1c: awaitHuman falls back from empty explicit options to named outcomes', async () => {
  const { deps, pushInboxCalls } = makeDeps({ decision: { outcome: 'rework' } });
  const awaitHuman = makeAwaitHuman(deps);

  await awaitHuman(
    'run-ah-empty-options',
    'merge',
    'codeStuckGate',
    'Code review stuck',
    { nodeId: 'codeStuckGate', outcomes: ['approve_anyway', 'rework', 'cancel'] },
    [],
  );

  assert.deepEqual(pushInboxCalls[0]?.item.options, ['approve_anyway', 'rework', 'cancel']);
});

test('A1 (merge gate): awaitHuman works for merge topic too', async () => {
  const runId = 'run-ah-a1m';
  const topic = 'merge' as const;
  const { deps, pushInboxCalls } = makeDeps({ decision: { decision: 'approve' } });

  const awaitHuman = makeAwaitHuman(deps);
  await awaitHuman(runId, topic, topic, 'Merge approval', { prUrl: 'stub://pr/1' });

  assert.equal(pushInboxCalls[0]?.item.kind, 'approval');
  const expectedId = `inbox_${fnv1a64Hex(`${runId}|${topic}`)}`;
  assert.equal(pushInboxCalls[0]?.id, expectedId);
});

// ─── A2: recv null → fail-closed reject (E7) ─────────────────────────────────

test('A2: awaitDecision returns null → awaitHuman returns fail-closed reject (E7)', async () => {
  const runId = 'run-ah-a2';
  const { deps } = makeDeps({ decision: null });

  const awaitHuman = makeAwaitHuman(deps);
  const result = await awaitHuman(runId, 'plan', 'plan', 'Plan approval', {});

  assert.equal(result.decision, 'reject', 'null recv must produce reject (fail-closed)');
  assert.equal(result.outcome, undefined, 'timeout fallback must not select a named outcome');
  const answer = result.answer as Record<string, unknown> | undefined;
  assert.equal(answer?.reason, 'gate-timeout', 'timeout reason must be gate-timeout');
});

test('A2b: named gate timeout does not approve or cancel by selecting the last outcome', async () => {
  const { deps, pushInboxCalls } = makeDeps({ decision: null });
  const awaitHuman = makeAwaitHuman(deps);

  const result = await awaitHuman('run-ah-named-timeout', 'plan', 'codeStuckGate', 'Code review stuck', {
    nodeId: 'codeStuckGate',
    outcomes: ['approve_anyway', 'rework', 'cancel'],
  });

  assert.deepEqual(pushInboxCalls[0]?.item.options, ['approve_anyway', 'rework', 'cancel']);
  assert.equal(result.decision, 'reject');
  assert.equal(result.outcome, undefined);
});

// ─── A3 (G11): replay — pushInbox returns SAME id on both calls, awaitHuman proceeds ──

test('A3 (G11): awaitHuman proceeds idempotently when pushInbox returns same id on replay', async () => {
  const runId = 'run-ah-a3';
  const topic = 'plan' as const;
  const expectedId = `inbox_${fnv1a64Hex(`${runId}|${topic}`)}`;

  let pushCallCount = 0;
  const pushInboxCalls: string[] = [];
  const awaitDecisionTopics: string[] = [];

  // The fake pushInbox returns the SAME deterministic id on BOTH calls.
  // This models the real pushInbox's ROW_CONFLICT-catch-and-continue behavior: the verb
  // swallows ROW_CONFLICT internally and returns the existing id — it NEVER throws.
  // (The throwing-ROW_CONFLICT case is tested in inbox.test.ts A8.)
  const deps: AwaitHumanDeps = {
    pushInbox: async (_item, id) => {
      pushCallCount++;
      pushInboxCalls.push(id);
      return id; // same id on every call (models catch-and-continue)
    },
    awaitDecision: async <T>(topic: string): Promise<T | null> => {
      awaitDecisionTopics.push(topic);
      return { decision: 'approve' } as T;
    },
    appendEvent: async () => undefined,
  };

  const awaitHuman = makeAwaitHuman(deps);

  // First call.
  const result1 = await awaitHuman(runId, topic, topic, 'Plan approval', {});
  assert.equal(result1.decision, 'approve', 'first call must resolve');
  assert.equal(pushCallCount, 1, 'pushInbox called once on first invocation');
  assert.equal(pushInboxCalls[0], expectedId, 'deterministic id on first call');

  // Second call (replay) — same args, same id returned, awaitHuman must not throw.
  const result2 = await awaitHuman(runId, topic, topic, 'Plan approval', {});
  assert.equal(result2.decision, 'approve', 'replay must not throw and must resolve');
  assert.equal(pushCallCount, 2, 'pushInbox called again on replay (verb handles ROW_CONFLICT internally)');
  assert.equal(pushInboxCalls[1], expectedId, 'same deterministic id on replay');
  // awaitDecision called each time (DBOS-native idempotent — checkpointed result on replay).
  assert.equal(awaitDecisionTopics.length, 2, 'awaitDecision called on each replay');
});

// ─── Deterministic id properties ─────────────────────────────────────────────

test('deterministic id is the same across two calls with the same runId+topic', async () => {
  const runId = 'run-det';
  const ids: string[] = [];
  const deps: AwaitHumanDeps = {
    pushInbox: async (_item, id) => { ids.push(id); return id; },
    awaitDecision: async <T>(_topic: string): Promise<T | null> => ({ decision: 'approve' } as T),
    appendEvent: async () => undefined,
  };

  const awaitHuman = makeAwaitHuman(deps);
  await awaitHuman(runId, 'plan', 'plan', 'T', {});
  await awaitHuman(runId, 'plan', 'plan', 'T different', {});

  assert.equal(ids[0], ids[1], 'same runId+topic must always produce the same id');
});

test('deterministic id differs between plan and merge topics for the same runId', async () => {
  const runId = 'run-det2';
  const ids: string[] = [];
  const deps: AwaitHumanDeps = {
    pushInbox: async (_item, id) => { ids.push(id); return id; },
    awaitDecision: async <T>(_topic: string): Promise<T | null> => ({ decision: 'approve' } as T),
    appendEvent: async () => undefined,
  };

  const awaitHuman = makeAwaitHuman(deps);
  await awaitHuman(runId, 'plan', 'plan', 'T', {});
  await awaitHuman(runId, 'merge', 'merge', 'T', {});

  assert.notEqual(ids[0], ids[1], 'plan and merge must produce different ids (topic isolation E8)');
});

test('deterministic id differs per gateKey for the SAME topic (re-entered gate — §3.2 fix)', async () => {
  // A generic template can re-enter the same gate node (e.g. a `question` gate looped in the review
  // phase) — each entry must get its OWN inbox row, not collide on `runId|topic` and leave the 2nd
  // entry with no fresh pending item (the workflow then parks on recv forever).
  const runId = 'run-det3';
  const ids: string[] = [];
  const deps: AwaitHumanDeps = {
    pushInbox: async (_item, id) => { ids.push(id); return id; },
    awaitDecision: async <T>(_topic: string): Promise<T | null> => ({ decision: 'approve' } as T),
    appendEvent: async () => undefined,
  };

  const awaitHuman = makeAwaitHuman(deps);
  await awaitHuman(runId, 'question', 'questionGate#1', 'Q1', {});
  await awaitHuman(runId, 'question', 'questionGate#2', 'Q2', {});

  assert.notEqual(ids[0], ids[1], 'two entries of a same-topic gate must produce distinct inbox ids');
});
