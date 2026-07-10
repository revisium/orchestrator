import assert from 'node:assert/strict';
import test from 'node:test';
import { CasePlanRegistry } from './case-plan.js';

test('reserved next-task plans are immutable and claimed exactly once', () => {
  const registry = new CasePlanRegistry();
  const cancel = registry.reserveNext({
    title: 'recovery child',
    agent: { byRole: { developer: { kind: 'pass' } } },
  });

  const claimed = registry.get('task_recovery');
  assert.ok(claimed);
  assert.equal(Object.isFrozen(claimed), true);
  assert.equal(Object.isFrozen(claimed.agent?.byRole), true);
  assert.equal(registry.get('task_recovery'), claimed);
  assert.equal(registry.get('task_unrelated'), undefined);
  cancel();
});

test('cancelling an unclaimed next-task plan leaves no fallback behavior', () => {
  const registry = new CasePlanRegistry();
  const cancel = registry.reserveNext({ title: 'cancelled reservation' });

  cancel();

  assert.equal(registry.get('task_later'), undefined);
});
