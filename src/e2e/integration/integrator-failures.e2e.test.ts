import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createIntegrationContext,
  type IntegrationContext,
  type IntegrationGhScenario,
  type IntegrationTarget,
} from '../support/integration-context.js';

let integration: IntegrationContext;
const PLAN_GATE = { topic: 'plan', options: ['approved'] } as const;
const MERGE_OPTIONS = ['approved', 'recheck', 'override_merge', 'cancel'] as const;
const RECOVERY_OPTIONS = ['recheck', 'cancel'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  integration = await createIntegrationContext();
});

after(async () => {
  if (integration) await integration.close();
});

async function prepareFeature(
  target: IntegrationTarget,
  options: Readonly<{ title?: string; gh?: IntegrationGhScenario }> = {},
) {
  return integration.prepare({
    title: options.title ?? 'E2E integrator-failure feature run',
    repo: target,
    pipelineId: 'feature-development',
    profile: 'fixture-agent',
    ...(options.gh ? { gh: options.gh } : {}),
  });
}

test('D3: a dirty target repository blocks at preflight', { skip: e2eSkip }, async () => {
  const target = integration.target({ dirty: true });
  const run = await prepareFeature(target);
  await run.start();
  await run.settle('blocked');
  await run.expectBlocked();
});

test('D3b: a repaired preflight block resumes through one recovery child', { skip: e2eSkip }, async () => {
  const target = integration.target({ dirty: true });
  const parent = await prepareFeature(target);
  await parent.start();
  await parent.expectBlocked();
  target.repairDirty();

  const child = await parent.resumePreflightRecovery(target);
  await child.waitAtGate(PLAN_GATE);
  await child.resolveGate({ ...PLAN_GATE, outcome: 'approved' });
  await child.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await child.settle('completed');
  await parent.expectRecoveryLineage(child);
});

test('D4: a stale caller starts from fresh origin/master without switching the caller', { skip: e2eSkip }, async () => {
  const target = integration.target({ staleBranch: true });
  const run = await prepareFeature(target);
  await run.start();
  await run.waitAtGate(PLAN_GATE);

  const worktree = run.worktreeObservation();
  assert.equal(worktree.exists, true);
  assert.equal(worktree.markerExists, true);
  assert.equal(worktree.branch, worktree.expectedBranch);
  assert.equal(worktree.head, worktree.originMaster);
  assert.ok(worktree.files.includes('moved.txt'));
  assert.deepEqual(target.baseObservation(), { branch: 'stale-feature', clean: true });

  await run.resolveGate({ ...PLAN_GATE, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await run.settle('completed');
  assert.deepEqual(target.baseObservation(), { branch: 'stale-feature', clean: true });
});

for (const [caseId, state, lessonIncludes] of [
  ['D5', { baseAhead: true }, ['local-only or diverged', 'origin/master']],
  ['D6', { baseMissing: true }, ['git fetch origin master failed', 'base branch may not exist on remote']],
] as const) {
  test(`${caseId}: invalid base state blocks at preflight`, { skip: e2eSkip }, async () => {
    const target = integration.target(state);
    const run = await prepareFeature(target);
    await run.start();
    await run.settle('blocked');
    await run.expectBlockedDecision({ reason: 'preflight', lessonIncludes });
  });
}

test('D8: a non-GitHub origin reaches recovery after real remote parsing', { skip: e2eSkip }, async () => {
  const target = integration.target({ nonGithubRemote: true });
  const run = await prepareFeature(target);
  await run.start();
  await run.resolveGate({ ...PLAN_GATE, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' });
  await run.settle('cancelled');
});

test('D20 integration: confirm-merge recovery preserves the real worktree', { skip: e2eSkip }, async () => {
  const target = integration.target();
  const run = await prepareFeature(target, {
    title: 'D20: preserve worktree after confirm merge block',
    gh: 'merge-not-clean',
  });
  await run.start();
  await run.resolveGate({ ...PLAN_GATE, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' });
  await run.settle('cancelled');
  await run.expectBlockedDecision({
    reason: 'confirm-merge',
    lessonIncludes: ['not auto-mergeable', 'mergeStateStatus=BLOCKED'],
  });
  assert.equal(run.worktreeObservation().exists, true);
});

test('D22: developer output and the integration commit live in the given worktree', { skip: e2eSkip }, async () => {
  const target = integration.target();
  const run = await prepareFeature(target, {
    gh: 'merge-not-clean',
  });
  await run.start();
  await run.resolveGate({ ...PLAN_GATE, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' });
  await run.settle('cancelled');

  const worktree = run.worktreeObservation();
  assert.ok(worktree.files.some((file) => /^developer-.*\.txt$/.test(file)));
  assert.ok(worktree.aheadOfOriginMaster > 0);
});
