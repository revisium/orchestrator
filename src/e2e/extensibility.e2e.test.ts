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
