import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import { resolveGateSequence } from './drive.js';

type GateFixture = Readonly<{
  topic: string;
  options: readonly string[];
}>;

function gateApi(gates: readonly GateFixture[]): Readonly<{
  api: TaskControlPlaneApiService;
  resolved: Array<{ inboxId: string; outcome: string; resolvedBy?: string }>;
}> {
  const pending = [...gates];
  const resolved: Array<{ inboxId: string; outcome: string; resolvedBy?: string }> = [];
  const api = {
    async waitForRun() {
      const gate = pending[0];
      if (!gate) {
        return {
          state: 'completed',
          workflowStatus: 'SUCCESS',
          runStatus: 'completed',
          nextAction: '',
          runId: 'run-1',
        };
      }
      return {
        state: 'pending_gate',
        workflowStatus: 'PENDING',
        runStatus: 'running',
        nextAction: '',
        runId: 'run-1',
        inbox: {
          id: `inbox-${resolved.length + 1}`,
          context: { topic: gate.topic, summary: { outcomes: gate.options } },
          options: [...gate.options],
        },
      };
    },
    async resolveGate(input: { inboxId: string; outcome: string; resolvedBy?: string }) {
      resolved.push(input);
      pending.shift();
      return {};
    },
  } as unknown as TaskControlPlaneApiService;
  return { api, resolved };
}

test('resolveGateSequence resolves only the explicitly declared topics, options, and outcomes', async () => {
  const fixture = gateApi([
    { topic: 'plan', options: ['approved'] },
    { topic: 'merge', options: ['approved', 'recheck', 'override_merge', 'cancel'] },
  ]);

  const result = await resolveGateSequence(fixture.api, 'run-1', [
    { topic: 'plan', options: ['approved'], outcome: 'approved' },
    {
      topic: 'merge',
      options: ['approved', 'recheck', 'override_merge', 'cancel'],
      outcome: 'approved',
    },
  ]);

  assert.equal(result.state, 'completed');
  assert.deepEqual(result.resolvedTopics, ['plan', 'merge']);
  assert.deepEqual(fixture.resolved, [
    { inboxId: 'inbox-1', outcome: 'approved', resolvedBy: 'e2e' },
    { inboxId: 'inbox-2', outcome: 'approved', resolvedBy: 'e2e' },
  ]);
});

test('resolveGateSequence rejects an unexpected topic before resolving it', async () => {
  const fixture = gateApi([{ topic: 'retry', options: ['retry', 'cancel'] }]);

  await assert.rejects(
    () => resolveGateSequence(fixture.api, 'run-1', [
      { topic: 'plan', options: ['approved'], outcome: 'approved' },
    ]),
    /expected plan gate, got retry/,
  );
  assert.deepEqual(fixture.resolved, []);
});

test('resolveGateSequence rejects unexpected options and unavailable outcomes before resolving', async () => {
  const unexpectedOptions = gateApi([{ topic: 'plan', options: ['manual_review', 'defer'] }]);
  await assert.rejects(
    () => resolveGateSequence(unexpectedOptions.api, 'run-1', [
      { topic: 'plan', options: ['approved'], outcome: 'approved' },
    ]),
    /unexpected plan gate options/,
  );
  assert.deepEqual(unexpectedOptions.resolved, []);

  const unavailableOutcome = gateApi([{ topic: 'plan', options: ['manual_review'] }]);
  await assert.rejects(
    () => resolveGateSequence(unavailableOutcome.api, 'run-1', [
      { topic: 'plan', options: ['manual_review'], outcome: 'approved' },
    ]),
    /outcome approved is not available/,
  );
  assert.deepEqual(unavailableOutcome.resolved, []);
});

test('resolveGateSequence rejects added, missing, and reordered options before resolving', async () => {
  for (const actual of [
    ['approved', 'cancel', 'surprise'],
    ['approved'],
    ['cancel', 'approved'],
  ]) {
    const fixture = gateApi([{ topic: 'plan', options: actual }]);
    await assert.rejects(
      () => resolveGateSequence(fixture.api, 'run-1', [
        { topic: 'plan', options: ['approved', 'cancel'], outcome: 'approved' },
      ]),
      /unexpected plan gate options/,
    );
    assert.deepEqual(fixture.resolved, []);
  }
});

test('resolveGateSequence rejects an undeclared additional gate', async () => {
  const fixture = gateApi([
    { topic: 'plan', options: ['approved'] },
    { topic: 'merge', options: ['approved', 'cancel'] },
  ]);

  await assert.rejects(
    () => resolveGateSequence(fixture.api, 'run-1', [
      { topic: 'plan', options: ['approved'], outcome: 'approved' },
    ]),
    /unexpected additional gate merge/,
  );
});
