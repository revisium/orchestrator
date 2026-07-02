import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  createTargetRepo,
  type TargetRepo,
  waitForGate,
  waitState,
} from './kit/index.js';

// Group R — #246 recovery-policy graph: mergeApproveReverify + recoveryGate.
//
// The `feature-development` pipeline in the e2e fixture carries the full #246 recovery graph:
// mergeGate(approved|recheck|override_merge|cancel) → mergeApproveReverify → classifyRecovery →
// recoveryRouter → recoveryGate. These cases exercise each new branch in stub mode (no real git/gh)
// so the graph routing is tested end-to-end without external service dependencies.
//
// Gate topic strings in the e2e fixture: 'plan-review', 'merge-review', 'merge-recovery'.

const STUB_FULL = { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } };

async function startPrReviewRun(h: RunHarness, repo: string) {
  const created = await h.api.createRun({
    repo,
    title: 'E2E recovery-graph #246 run',
    description: 'Group R — mergeApproveReverify + recoveryGate on real DBOS/Revisium.',
    scope: 'recovery-graph e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    executionProfile: STUB_FULL,
    start: true,
  });
  if (!('workflow' in created)) throw new Error('start:true must return workflow metadata');
  return created;
}

let h: RunHarness;
let target: TargetRepo;

before(async () => {
  if (!RUN_REAL_E2E) return;
  target = createTargetRepo();
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
  if (target) target.cleanup();
});

test('RG-A: mergeGate approve → mergeApproveReverify(stub:clean) → confirmMerge → completed', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  assert.equal(plan.topic, 'plan-review', 'first gate is the plan gate');
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge-review', 'second gate is the merge gate');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'completed', 'approve path: mergeApproveReverify(clean) → confirmMerge → completed');
});

test('RG-B: mergeGate cancel → cancelledEnd → cancelled', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge-review');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'cancel', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'cancelled', 'cancel outcome routes to cancelledEnd');
});

test('RG-C: mergeGate override_merge → mergeApproveReverify(stub:clean) → confirmMerge → completed', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge-review');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'override_merge', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'completed', 'override_merge also routes through mergeApproveReverify → completed');
});

test('RG-D: mergeGate recheck → mergeRecheck(stub:clean) → blockedEnd → blocked', { skip: e2eSkip }, async () => {
  // A human `recheck` on the merge gate re-polls readiness via mergeRecheck; if the re-poll returns
  // `clean` (mergeRecheckRouter.clean → blockedEnd) the run settles as blocked — an explicit abort by
  // the reviewer who found nothing changed since the gate opened.
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge-review');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'recheck', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'blocked', 'recheck + still-clean re-poll routes to blockedEnd (explicit abort)');
});

test('RG-E: always-ci-red → ciLoop exhaustion → recoveryGate(merge-recovery) → cancel → cancelled', { skip: e2eSkip }, async () => {
  // Uses the real integrator wired to an `always-ci-red` gh emulator so every pollPr returns
  // `ci_changes`. After 3 ciRework cycles prRouter.otherwise → recoveryGate; human cancels.
  const calls: string[][] = [];
  const hE = await createRunHarness({ gh: 'always-ci-red' });
  const targetE = createTargetRepo();
  try {
    await givenInstalledPlaybook(hE);
    const created = await hE.api.createRun({
      repo: targetE.worktree,
      title: 'RG-E always-ci-red run',
      description: 'RG-E — ciLoop exhaustion → recoveryGate → cancel.',
      scope: 'recovery-graph e2e',
      playbookId: PLAYBOOK_ID,
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
      start: true,
    });
    if (!('workflow' in created)) throw new Error('start:true must return workflow metadata');
    hE.developerWrites.set(created.runId, targetE.worktree);

    const plan = await waitForGate(hE.api, created.runId);
    await hE.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

    // ciLoop exhausts → recoveryGate opens (topic: 'merge-recovery')
    const recovery = await waitForGate(hE.api, created.runId);
    assert.equal(recovery.topic, 'merge-recovery', 'ciLoop exhaustion opens recoveryGate');
    await hE.api.resolveGate({ inboxId: recovery.inboxId, outcome: 'cancel', resolvedBy: 'e2e' });

    const terminal = await waitState(hE.api, created.runId);
    assert.equal(terminal.state, 'cancelled', 'cancel outcome at recoveryGate → cancelledEnd → cancelled');
    void calls; // silence unused warning
  } finally {
    await hE.close();
    targetE.cleanup();
  }
});
