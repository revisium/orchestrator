import assert from 'node:assert/strict';
import test from 'node:test';
import { TeardownContext } from './teardown-context.js';
import type { TargetRepo } from './git-target-repo.js';
import type { HostFixture } from './harness.js';

test('teardown context rejects a second parked target and retains the first for cleanup', async () => {
  let targetCreations = 0;
  let targetCleanups = 0;
  let parkedTarget: TargetRepo | undefined;
  const target = {
    root: '/tmp/teardown-target',
    worktree: '/tmp/teardown-target/worktree',
    repairDirty() {},
    cleanup() { targetCleanups += 1; },
  } satisfies TargetRepo;
  const host = { async close() {} } as unknown as HostFixture;
  const context = new TeardownContext(
    host,
    () => {
      targetCreations += 1;
      return target;
    },
    async (_host, selectedTarget) => {
      parkedTarget = selectedTarget;
    },
  );

  await context.parkAtHumanGate();
  await assert.rejects(context.parkAtHumanGate(), /already has a parked target/);

  assert.equal(targetCreations, 1);
  assert.strictEqual(parkedTarget, target);
  await context.cleanup();
  assert.equal(targetCleanups, 1);
});
