import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  createConcurrencyContext,
  type ConcurrencyContext,
} from '../../support/concurrency-context.js';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';

let runtime: ConcurrencyContext;

const approvalSequence = [
  { topic: 'plan', options: ['approved'], outcome: 'approved' },
  {
    topic: 'merge',
    options: ['approved', 'recheck', 'override_merge', 'cancel'],
    outcome: 'approved',
  },
] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  runtime = await createConcurrencyContext();
});

after(async () => {
  if (runtime) await runtime.close();
});

test('J1: queued runs beyond the worker limit all drain without loss', { skip: e2eSkip }, async () => {
  const runs = await runtime.startLocalChanges(10);
  assert.equal(new Set(runs.map((run) => run.runId)).size, 10);
  for (const run of runs) assert.equal(await run.waitForState(), 'completed');
});

test('J2: concurrent double-start executes one durable workflow', { skip: e2eSkip }, async () => {
  const run = await runtime.prepareDoubleStart();
  await run.doubleStart();
  assert.equal(await run.waitForState(), 'completed');
  await run.expectEventCount('run_completed', 1);
  await run.expectEventCount('step_succeeded', 1);
});

test('J3: concurrent runs retain isolated event streams', { skip: e2eSkip }, async () => {
  const runs = await runtime.startLocalChanges(4);
  for (const run of runs) {
    assert.equal(await run.waitForState(), 'completed');
    await run.expectEventCount('run_created', 1);
    await run.expectEventCount('step_succeeded', 1);
    await run.expectEventCount('run_completed', 1);
  }
});

test('J4: concurrent gates resolve independently', { skip: e2eSkip }, async () => {
  const targets = Array.from({ length: 3 }, () => runtime.createTarget());
  try {
    const runs = await runtime.startFeatures(targets, 'stubbed');
    await Promise.all(runs.map((run) => run.waitForGate('plan')));
    const terminals = await Promise.all(runs.map((run) => run.resolveToTerminal(approvalSequence)));
    assert.deepEqual(terminals, ['completed', 'completed', 'completed']);
  } finally {
    targets.forEach((target) => target.cleanup());
  }
});

test('J5: concurrent opposite gate decisions keep their own terminals', { skip: e2eSkip }, async () => {
  const targets = [runtime.createTarget(), runtime.createTarget()];
  try {
    const [approved, rejected] = await runtime.startFeatures(targets, 'stubbed');
    assert.ok(approved && rejected);
    await Promise.all([approved.waitForGate('plan'), rejected.waitForGate('plan')]);
    const [completed] = await Promise.all([
      approved.resolveToTerminal(approvalSequence),
      rejected.rejectGate('plan'),
    ]);
    assert.equal(completed, 'completed');
    await rejected.waitForState();
    assert.notEqual(await rejected.status(), 'completed');
    await approved.expectEventCount('merge_confirmed', 1);
    await rejected.expectEvents(['pipeline_blocked']);
  } finally {
    targets.forEach((target) => target.cleanup());
  }
});

test('J6: two live runs share a repo only through isolated worktrees', { skip: e2eSkip }, async () => {
  const target = runtime.createTarget();
  try {
    const [runA, runB] = await runtime.startFeatures([target, target], 'real-git');
    assert.ok(runA && runB);
    assert.notEqual(runA.runId, runB.runId);
    assert.notEqual(runA.taskId, runB.taskId);
    const terminals = await Promise.all([
      runA.resolveToTerminal(approvalSequence),
      runB.resolveToTerminal(approvalSequence),
    ]);
    assert.deepEqual(terminals, ['completed', 'completed']);
    const branchA = runA.prBranch();
    const branchB = runB.prBranch();
    assert.notEqual(branchA, branchB);
    assert.deepEqual(target.baseObservation(), { branch: 'master', clean: true });
    assert.equal(target.commitsAhead(branchA), 1);
    assert.equal(target.commitsAhead(branchB), 1);
  } finally {
    target.cleanup();
  }
});
