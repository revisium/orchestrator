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
  type GhScenario,
  routedGhEmulator,
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
// Gate TOPICS are bucketed by `gateTopicFor` (data-driven-task.workflow.ts) from the gate REASON:
// anything matching /merge/i → 'merge', /question/i → 'question', else → 'plan'. So the fixture's
// reasons map to topics: 'plan-review' → 'plan'; 'merge-review' → 'merge'; 'merge-recovery' → 'merge'
// (recoveryGate shares the 'merge' topic because its reason contains "merge").

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
// Per-run gh scenarios keyed by taskId (RG-E needs `always-ci-red`; RG-A..D are stub-integrator and
// never touch gh). One shared harness per file — DBOS is process-global, so a SECOND coexisting host
// would let the file-level worker pick up another run and execute its developer step without this
// run's developerWrites, blocking integrate on "nothing to integrate". Route gh per run instead.
const ghScenarios = new Map<string, GhScenario>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  target = createTargetRepo();
  h = await createRunHarness({ gh: (calls) => routedGhEmulator(ghScenarios, calls) });
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
  if (target) target.cleanup();
});

test('RG-A: mergeGate approve → mergeApproveReverify(stub:clean) → confirmMerge → completed', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  assert.equal(plan.topic, 'plan', 'first gate is the plan gate (reason plan-review → topic plan)');
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge', 'second gate is the merge gate (reason merge-review → topic merge)');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'completed', 'approve path: mergeApproveReverify(clean) → confirmMerge → completed');
});

test('RG-B: mergeGate cancel → cancelledEnd → cancelled', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'cancel', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'cancelled', 'cancel outcome routes to cancelledEnd');
});

test('RG-C: mergeGate override_merge → mergeApproveReverify(stub:clean) → confirmMerge → completed', { skip: e2eSkip }, async () => {
  const run = await startPrReviewRun(h, target.worktree);
  const plan = await waitForGate(h.api, run.runId);
  await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

  const merge = await waitForGate(h.api, run.runId);
  assert.equal(merge.topic, 'merge');
  // override_merge is a guarded outcome: the reviewer must attach a mergeOverrideAudit recording WHICH
  // threads they are overriding and WHO owns the residual risk (validateMergeOverrideAudit). A bare
  // override is rejected — supply a complete audit record so the gate resolves.
  await h.api.resolveGate({
    inboxId: merge.inboxId,
    outcome: 'override_merge',
    resolvedBy: 'e2e',
    mergeOverrideAudit: {
      threadIds: ['PRRT_OVERRIDE'],
      actor: 'e2e',
      reason: 'e2e override: reviewed and accepting the open thread',
      risk: 'low — synthetic stub run, no real merge side effects',
      verificationResponsibility: 'e2e harness',
      headSha: 'e2e-stub-head',
    },
  });

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
  assert.equal(merge.topic, 'merge');
  await h.api.resolveGate({ inboxId: merge.inboxId, outcome: 'recheck', resolvedBy: 'e2e' });

  const terminal = await waitState(h.api, run.runId);
  assert.equal(terminal.state, 'blocked', 'recheck + still-clean re-poll routes to blockedEnd (explicit abort)');
});

test('RG-E: always-ci-red → ciLoop exhaustion → recoveryGate(merge-recovery) → cancel → cancelled', { skip: e2eSkip }, async () => {
  // Uses the REAL integrator (revo-integrator NOT stubbed) with the shared harness's gh routed to
  // `always-ci-red`, so every pollPr returns `ci_changes`. After 3 ciRework cycles prRouter.otherwise →
  // recoveryGate; the human cancels. Runs on the shared file harness `h` (never a second coexisting
  // host) so the file worker executes THIS run's developer step with its developerWrites — otherwise the
  // developer writes nothing and integrate blocks on "nothing to integrate".
  const targetE = createTargetRepo();
  try {
    const created = await h.api.createRun({
      repo: targetE.worktree,
      title: 'RG-E always-ci-red run',
      description: 'RG-E — ciLoop exhaustion → recoveryGate → cancel.',
      scope: 'recovery-graph e2e',
      playbookId: PLAYBOOK_ID,
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
      start: false,
    });
    // Register the per-run gh scenario + developer write BEFORE starting so pollPr sees always-red CI
    // and the developer produces a diff for the real integrator to push.
    ghScenarios.set(created.taskId, 'always-ci-red');
    h.developerWrites.set(created.runId, targetE.worktree);
    await h.api.startRun({ runId: created.runId });

    const plan = await waitForGate(h.api, created.runId);
    await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });

    // ciLoop exhausts → recoveryGate opens (reason 'merge-recovery' → topic 'merge', per gateTopicFor)
    const recovery = await waitForGate(h.api, created.runId);
    assert.equal(recovery.topic, 'merge', 'ciLoop exhaustion opens recoveryGate (merge-recovery reason → merge topic)');
    await h.api.resolveGate({ inboxId: recovery.inboxId, outcome: 'cancel', resolvedBy: 'e2e' });

    const terminal = await waitState(h.api, created.runId);
    assert.equal(terminal.state, 'cancelled', 'cancel outcome at recoveryGate → cancelledEnd → cancelled');
  } finally {
    targetE.cleanup();
  }
});
