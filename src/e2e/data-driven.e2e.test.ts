import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  createTargetRepo,
  type TargetRepo,
  startDataDrivenRun,
  DATA_DRIVEN_PIPELINE,
  routedScriptedAgent,
  type AgentSpec,
  waitForGate,
  waitState,
  approveUntilTerminal,
  assertEventsPresent,
  assertBlocked,
  executedRoles,
} from './kit/index.js';

// Group L — DATA-DRIVEN PIPELINE on real DBOS (plan 0015 slice 2).
//
// The hardcoded develop-task workflow is the existing engine; this group proves the PARALLEL data-
// driven adapter executes the pure pipeline-core graph (the `feature-development-dd` fixture template,
// embedded as DATA in the playbook) on real DBOS/Revisium — driving plan→merge gates to completion,
// surviving crash-recovery, and enforcing the bounded rework cap to `blocked`. Selection is additive:
// only a pipeline carrying a state-machine template routes here; Groups A–K stay on the old path.
//
// The agent + integrator are stubbed (runnerOverrides) so no real claude/git/gh runs. The agent is
// scripted per-run so a test can choose each node's DOMAIN verdict (the watcher must emit `clean` to
// reach the merge gate; the reviewer emits `blocker` to drive the rework loop).

let h: RunHarness;
let target: TargetRepo;
const specs = new Map<string, AgentSpec>();

// The data-driven watcher node routes on a `clean` DOMAIN verdict; everything else PASS by default.
const cleanWatcher: AgentSpec = { byRole: { watcher: { kind: 'domainVerdict', verdict: 'clean' } } };

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: (sink) => routedScriptedAgent(specs, sink) });
  await givenInstalledPlaybook(h);
  target = createTargetRepo(); // clean repo so any preflight passes (stub integrator never writes)
});

after(async () => {
  if (target) target.cleanup();
  if (h) await h.close();
});

test('L0: the data-driven pipeline is routed (carries a state-machine template; engine=data-driven)', { skip: e2eSkip }, async () => {
  const route = (await h.api.simulateRoute({ title: 'route', pipeline: DATA_DRIVEN_PIPELINE })) as unknown as {
    pipelineId: string;
    roles: string[];
    executionPolicy: { template_json?: { specVersion?: string; nodes?: Record<string, unknown> } };
  };
  assert.equal(route.pipelineId, DATA_DRIVEN_PIPELINE);
  // The selection signal: a template_json with a specVersion + nodes lives in the pipeline's policy data.
  assert.equal(route.executionPolicy.template_json?.specVersion, '1.0');
  assert.ok(route.executionPolicy.template_json?.nodes?.['analyst'], 'template carries the analyst node');
  // The capability handles the adapter resolves must all be bound from the route roles (generic engine).
  for (const roleId of ['analyst', 'developer', 'reviewer', 'watcher', 'integrator']) {
    assert.ok(route.roles.includes(roleId), `route binds ${roleId} (resolves a roleRef/scriptRef)`);
  }
});

test('L1: a data-driven run drives plan→merge gates to completed on real DBOS/Revisium', { skip: e2eSkip }, async () => {
  const run = await startDataDrivenRun(h, target, specs, cleanWatcher);
  assert.equal((run.started as { engine?: string }).engine, 'data-driven', 'startRun selected the data-driven adapter');

  // The pure core walks analyst → planGate → developer → codeReview → integrator(script) → watcherPost
  // → watcherRouter(clean) → mergeGate. Approving both gates drives it to the `succeeded` terminal.
  const terminal = await approveUntilTerminal(h.api, run.runId);
  assert.equal(terminal.state, 'completed');
  assert.deepEqual(terminal.approvedTopics, ['plan', 'merge'], 'both data-driven humanGate nodes opened in order');

  // The integrator script node ran (stub → integrate_succeeded) and the run completed — both via the adapter.
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);

  // The agent/script effects were dispatched through the SAME runner machinery (generic capabilities):
  // every roleRef resolved to its route binding and executed.
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  for (const roleId of ['analyst', 'developer', 'reviewer', 'watcher']) {
    assert.ok(roles.includes(roleId), `${roleId} executed via its resolved capability handle`);
  }
});

// L2 (data-driven crash-recovery) lives in its OWN file (data-driven-recovery.e2e.test.ts), mirroring
// recovery.e2e.test.ts: the crash must happen BEFORE any long-lived harness exists, else a competing
// host on the shared DBOS queue could steal + run the recovered workflow with the wrong agent.

test('L3: reviewer BLOCKER ×cap drives the bounded rework loop to blocked (counter cap is DATA)', { skip: e2eSkip }, async () => {
  // The template's codeReviewRouter routes blocker → reworkDeveloper while counter.lt(codeReviewLoop,3);
  // reworkDeveloper increments the scope. After the cap the guard is false → default → blockedEnd.
  // A reviewer that always emits BLOCKER (→ domain `blocker`) exhausts the cap and the run blocks.
  const blockerReviewer: AgentSpec = {
    byRole: { reviewer: { kind: 'verdict', verdict: 'BLOCKER' }, watcher: { kind: 'domainVerdict', verdict: 'clean' } },
  };
  const run = await startDataDrivenRun(h, target, specs, blockerReviewer);

  // Approve the plan gate; the run then loops codeReview↔reworkDeveloper and blocks before the merge gate.
  const plan = await waitForGate(h.api, run.runId, 'plan');
  await h.api.approveGate({ inboxId: plan.inboxId, resolvedBy: 'e2e' });
  await waitState(h.api, run.runId);

  await assertBlocked(h.api, run.runId);
  // The cap is 3 (codeReviewLoop): the developer reworks until the guard fails, so the developer ran
  // more than its single first pass (the rework loop fired). The interpreter — not the agent — caps it.
  const developerRuns = executedRoles(h, run.runId).filter(([role]) => role === 'developer').length;
  assert.ok(developerRuns >= 2, `the bounded rework loop reworked via the developer (${developerRuns} developer runs)`);
});
