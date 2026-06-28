import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  routedScriptedAgent,
  type AgentSpec,
  createTargetRepo,
  type TargetRepo,
  approveUntilTerminal,
  assertEventsPresent,
  assertBlocked,
  assertRoleStepAfterEvent,
  executedRoles,
} from './kit/index.js';

// Group K — pipeline extensibility: which role fills each phase comes from the installed playbook,
// not from code. The fixture playbook declares a `pr-watcher` role + a `feature-pr-watch` pipeline
// that embeds it post-integrator. These tests pin that a role plugged in via DATA alone still runs,
// drives the flow, and shows up in routing — the safety net for the data-driven-pipeline redesign.

const PIPELINE = 'feature-pr-watch';
const PIPELINE_POLL = 'feature-pr-poll'; // mirrors feature-pr-watch with an UNKNOWN-id pr-poller
const STUB_INTEGRATOR = { runnerOverrides: { 'revo-integrator': 'stub-agent' } }; // integrate without git/gh

let h: RunHarness;
let target: TargetRepo;
const specs = new Map<string, AgentSpec>(); // runId → scripted role verdicts

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: (sink) => routedScriptedAgent(specs, sink) });
  await givenInstalledPlaybook(h);
  target = createTargetRepo();
});

after(async () => {
  if (target) target.cleanup();
  if (h) await h.close();
});

/** Create + start a Group-K pipeline (stub integrator). `spec` scripts the embedded role's verdict. */
async function startRun(pipelineId: string, spec?: AgentSpec): Promise<{ runId: string; taskId: string }> {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E embedded role',
    description: 'Group K — role embedded into the pipeline via playbook data.',
    scope: 'extensibility e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId,
    executionProfile: STUB_INTEGRATOR,
    start: false,
  });
  if (spec) specs.set(created.runId, spec);
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

/** Run `simulateRoute` and narrow to the routing projection the extensibility assertions need. */
async function route(pipelineId: string) {
  return (await h.api.simulateRoute({ title: 'route', playbookId: PLAYBOOK_ID, pipeline: pipelineId })) as unknown as {
    pipelineId: string;
    roles: string[];
    roleBindings: Array<{ roleId: string } & Record<string, unknown>>;
  };
}

test('K1: an embedded post-integrator role declared only in playbook data runs and completes', { skip: e2eSkip }, async () => {
  const run = await startRun(PIPELINE);
  const terminal = await approveUntilTerminal(h.api, run.runId); // approve plan + merge
  assert.equal(terminal.state, 'completed');
  // `integrate_succeeded` proves the integrator ran; it is a stub runner, so it is NOT in
  // `executedRoles` (which records agent calls only). K3 proves pr-watcher is ordered after the integrator.
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);
  assert.ok(executedRoles(h, run.runId).some(([role]) => role === 'pr-watcher'), 'the embedded pr-watcher ran');
});

test('K2: the embedded role\'s blocker verdict drives the pipeline (watcher-fix loop -> blocks at the cap)', { skip: e2eSkip }, async () => {
  const run = await startRun(PIPELINE, { byRole: { 'pr-watcher': { kind: 'verdict', verdict: 'blocker' } } });
  await approveUntilTerminal(h.api, run.runId); // approve the plan gate; the run then blocks before merge
  await assertBlocked(h.api, run.runId);
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.ok(roles.includes('pr-watcher'), 'the embedded role ran');
  assert.ok(roles.filter((r) => r === 'developer').length >= 2, 'a blocker from the embedded role triggers developer rework');
});

test('K3: routing composes the pipeline from data — the embedded role appears after the integrator', { skip: e2eSkip }, async () => {
  const r = await route(PIPELINE);
  assert.equal(r.pipelineId, PIPELINE);
  assert.ok(r.roles.includes('pr-watcher'), 'pr-watcher is routed from the fixture pipeline data');
  assert.ok(r.roles.indexOf('pr-watcher') > r.roles.indexOf('integrator'), 'the embedded role is ordered post-integrator');
});

// K4/K5: an unknown-id role still routes from template placement alone — the engine resolves
// `role:<id>` as an opaque handle and reads no role `kind`. (K1/K3 cover a known id.)

test('K4: unknown-id pr-poller runs post-integrator and completes', { skip: e2eSkip }, async () => {
  const run = await startRun(PIPELINE_POLL);
  const terminal = await approveUntilTerminal(h.api, run.runId); // approve plan + merge
  assert.equal(terminal.state, 'completed');
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);
  assert.ok(executedRoles(h, run.runId).some(([role]) => role === 'pr-poller'), 'pr-poller ran');
  await assertRoleStepAfterEvent(h.api, run.runId, 'pr-poller', 'integrate_succeeded');
});

test('K5: routing binds the unknown-id pr-poller from data, ordered after integrator (no kind in the binding)', { skip: e2eSkip }, async () => {
  const r = await route(PIPELINE_POLL);
  assert.equal(r.pipelineId, PIPELINE_POLL);
  const pollerBinding = r.roleBindings.find((b) => b.roleId === 'pr-poller');
  assert.ok(pollerBinding, 'pr-poller is bound from the fixture pipeline data');
  assert.equal('kind' in pollerBinding, false, 'the binding carries no kind (the role-kind machinery was removed)');
  assert.ok(r.roles.indexOf('pr-poller') > r.roles.indexOf('integrator'), 'pr-poller is ordered post-integrator');
});
