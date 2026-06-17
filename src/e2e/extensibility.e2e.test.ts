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
  executedRoles,
} from './kit/index.js';

// Group K — PIPELINE EXTENSIBILITY (embedding a role/script into a pipeline via DATA).
//
// The pipeline SHAPE is code, but WHICH roles fill each phase comes from the installed playbook.
// The e2e fixture (src/e2e/fixtures/playbook) declares a `pr-watcher` role + a `feature-pr-watch`
// pipeline that embeds it post-integrator — i.e. a role plugged into the pipeline purely from data.
// These tests pin that behaviour (the safety net for a later data-driven-pipeline redesign): the
// embedded role runs after the integrator, its verdict drives the flow, and routing reflects it.
// One shared host; the agent is scripted per-run so we can choose the embedded role's verdict.

const PIPELINE = 'feature-pr-watch'; // fixture pipeline: orchestrator, analyst, reviewer, developer, integrator, pr-watcher
const PIPELINE_POLL = 'feature-pr-poll'; // mirrors feature-pr-watch but with an UNKNOWN-id pr-poller (kind:status) post-integrator
const STUB_INTEGRATOR = { runnerOverrides: { 'revo-integrator': 'stub-agent' } }; // integrate w/o git/gh

let h: RunHarness;
let target: TargetRepo; // clean repo so live preflight passes (stub integrator never writes to it)
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

/** Create + start the pr-watch pipeline (stub integrator). Optionally script the embedded role's verdict. */
async function startPrWatchRun(spec?: AgentSpec): Promise<{ runId: string; taskId: string }> {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E embedded pr-watcher',
    description: 'Group K — role embedded into the pipeline via playbook data.',
    scope: 'extensibility e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE,
    executionProfile: STUB_INTEGRATOR,
    start: false,
  });
  if (spec) specs.set(created.runId, spec);
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

/** Create + start the pr-poll pipeline (stub integrator) — the UNKNOWN-id, kind:status embedded role. */
async function startPrPollRun(spec?: AgentSpec): Promise<{ runId: string; taskId: string }> {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E embedded pr-poller',
    description: 'Group K — unknown-id role classified post-integrator via kind, from playbook data.',
    scope: 'extensibility e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_POLL,
    executionProfile: STUB_INTEGRATOR,
    start: false,
  });
  if (spec) specs.set(created.runId, spec);
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

test('K1: an embedded post-integrator role (pr-watcher) declared only in playbook data runs and completes', { skip: e2eSkip }, async () => {
  const run = await startPrWatchRun(); // default: every role PASS, incl the embedded pr-watcher
  const terminal = await approveUntilTerminal(h.api, run.runId); // approve plan + merge
  assert.equal(terminal.state, 'completed');
  // integrate_succeeded proves the integrator ran (it's a stub runner → not an agent call, so it is
  // not in executedRoles); K3 proves pr-watcher is ordered after the integrator in the route.
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.ok(roles.includes('pr-watcher'), 'the embedded pr-watcher role executed (from pipeline data, no code change)');
});

test('K2: the embedded role\'s BLOCKER verdict drives the pipeline (watcher-fix loop → blocks at the cap)', { skip: e2eSkip }, async () => {
  // pr-watcher always BLOCKER → the post-integrator loop reworks via the developer, then blocks at the cap.
  const run = await startPrWatchRun({ byRole: { 'pr-watcher': { kind: 'verdict', verdict: 'BLOCKER' } } });
  await approveUntilTerminal(h.api, run.runId); // approve the plan gate; the run then blocks before merge
  await assertBlocked(h.api, run.runId);
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.ok(roles.includes('pr-watcher'), 'the embedded role ran');
  assert.ok(roles.filter((r) => r === 'developer').length >= 2, 'a BLOCKER from the embedded role triggers developer rework');
});

test('K3: routing composes the pipeline from data — the embedded role appears after the integrator', { skip: e2eSkip }, async () => {
  const route = (await h.api.simulateRoute({ title: 'route', pipeline: PIPELINE })) as unknown as {
    pipelineId: string;
    roles: string[];
  };
  assert.equal(route.pipelineId, PIPELINE);
  assert.ok(route.roles.includes('pr-watcher'), 'pr-watcher is routed purely from the fixture pipeline data');
  assert.ok(
    route.roles.indexOf('pr-watcher') > route.roles.indexOf('integrator'),
    'the embedded role is ordered after the integrator (post-integrator phase)',
  );
});

// K4/K5 — the NEW capability (0014): a role whose id is UNKNOWN to every hardcoded classifier is
// CLASSIFIED as a post-integrator status role purely from its `kind: 'status'` in playbook data — with
// zero change to any code id-list. (K1/K3 above only prove a RECOGNIZED id, pr-watcher.)

test('K4: an UNRECOGNIZED-id role (pr-poller) placed post-integrator in the template runs and completes', { skip: e2eSkip }, async () => {
  const run = await startPrPollRun(); // default: every role PASS, incl the unknown-id pr-poller
  const terminal = await approveUntilTerminal(h.api, run.runId); // approve plan + merge
  assert.equal(terminal.state, 'completed');
  // The run completing proves the data-driven engine resolved the `role:pr-poller` capability handle to
  // its route binding by id alone (the engine holds ZERO role-ids — its post-integrator placement is the
  // template's node ordering, not a hardcoded classifier as in the removed engine).
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.ok(roles.includes('pr-poller'), 'the unknown-id pr-poller executed (resolved as a capability handle, no code change)');

  // Runtime ordering: integrate_succeeded must precede the pr-poller agent step (not merely both
  // present). The data-driven engine keys a step by its NODE id, so we identify the pr-poller step by
  // the ROLE recorded in the event payload (payload.role = the resolved role binding) — robust to the
  // template's node naming.
  const events = await h.api.getRunEvents({ runId: run.runId, limit: 50 });
  const integrateIdx = events.findIndex((e) => e.type === 'integrate_succeeded');
  const pollerStepIdx = events.findIndex((e) => {
    if (e.type !== 'step_succeeded') return false;
    const role = (e.payload as { role?: unknown } | undefined)?.role;
    // payload.role is the resolved role binding (the installed row id, playbook-prefixed) — match its
    // suffix so the assertion is robust to the install prefix and the template's node naming.
    return typeof role === 'string' && role.endsWith('pr-poller');
  });
  assert.ok(integrateIdx >= 0, 'integrate_succeeded was emitted');
  assert.ok(pollerStepIdx >= 0, "pr-poller's step_succeeded was emitted");
  assert.ok(integrateIdx < pollerStepIdx, 'the status role ran AFTER the integrator at runtime');
});

test('K5: routing threads kind to the binding — pr-poller binds kind:status, ordered after integrator', { skip: e2eSkip }, async () => {
  const route = (await h.api.simulateRoute({ title: 'route', pipeline: PIPELINE_POLL })) as unknown as {
    pipelineId: string;
    roles: string[];
    roleBindings: Array<{ roleId: string; kind?: string }>;
  };
  assert.equal(route.pipelineId, PIPELINE_POLL);
  assert.equal(route.roleBindings.find((b) => b.roleId === 'pr-poller')?.kind, 'status'); // kind threaded to binding
  assert.ok(
    route.roles.indexOf('pr-poller') > route.roles.indexOf('integrator'),
    'pr-poller is still ordered after the integrator (post-integrator phase)',
  );
});
