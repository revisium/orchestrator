import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenSeededDefaultPlaybook,
  DEFAULT_PLAYBOOK_ID,
  startDefaultFeatureRun,
  startDefaultLocalChangeRun,
  PLAYBOOK_ID,
  waitState,
  approveUntilTerminal,
  assertEventsPresent,
  assertCompleted,
  executedRoles,
  routedRunCaseAgent,
  type AgentSpec,
  type RunCase,
} from './kit/index.js';
import { validateTemplate } from '../pipeline-core/index.js';
import { coverageForScenario, type PipelineScenarioCoverage } from '../control-plane/pipeline-coverage-registry.js';

// Group M — the BUILT-IN DEFAULT playbook seeded by host bootstrap (slice 5, plan 0015).
//
// Distinct from Groups A–L, which install the e2e FIXTURE playbook (`revisium-agent-playbook`). This
// group proves the SHIPPED DEFAULT: a fresh host bootstrap seeds `revisium-default` (committed under
// control-plane/default-playbook/) so the control-plane has working `feature-development` and
// `local-change` pipelines plus feature-development run profiles out-of-the-box — no external
// agent-playbook repo, no fixture override.
//
// The bootstrap in scripts/e2e-setup.ts already seeds the default; givenSeededDefaultPlaybook only
// self-heals a reused test home that predates this slice (and never installs the fixture). The agent
// (and the script integrator, for feature-development) are stubbed via runnerOverrides so no real
// claude/git/gh runs; the default `feature-development` routes top-level domain verdicts past both
// routers, so the deterministic agent drives plan->merge to completion.

let h: RunHarness;
const runCases = new Map<string, RunCase>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: (sink) => routedRunCaseAgent(runCases, sink) });
  await givenSeededDefaultPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

async function startDefaultProfileRun(input: {
  title: string;
  profileId: string;
  coverage: PipelineScenarioCoverage;
  agent?: AgentSpec;
}) {
  const created = await h.api.createRun({
    repo: process.cwd(),
    title: input.title,
    description: 'Group M — default run profile coverage on the shipped feature pipeline.',
    scope: 'seeded-default run profile e2e',
    playbookId: DEFAULT_PLAYBOOK_ID,
    pipelineId: 'feature-development',
    profileId: input.profileId,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', codex: 'stub-agent', 'revo-integrator': 'stub-agent' } },
    start: false,
  });
  runCases.set(created.runId, {
    runId: created.runId,
    taskId: created.taskId,
    title: input.title,
    coverage: input.coverage,
    ...(input.agent ? { agent: input.agent } : {}),
  });
  const workflow = await h.api.startRun({ runId: created.runId });
  assert.equal((workflow as { engine?: string }).engine, 'data-driven', `${input.profileId} routes to the data-driven engine`);
  return { ...created, workflow };
}

test('M0: the bootstrap-seeded default playbook + pipelines are present and validate', { skip: e2eSkip }, async () => {
  // The default playbook is a distinct, installed record (NOT the e2e fixture).
  const playbooks = await h.api.listPlaybooks();
  assert.ok(playbooks.some((p) => p.id === DEFAULT_PLAYBOOK_ID), 'the seeded default playbook is installed');

  // Seeded pipelines exist under the default playbook and carry a data-driven template that
  // passes the AUTHORITATIVE validator (pipeline-core.validateTemplate) with zero errors.
  for (const pipelineId of ['feature-development', 'local-change']) {
    const route = (await h.api.simulateRoute({
      title: 'route',
      pipeline: pipelineId,
      playbookId: DEFAULT_PLAYBOOK_ID,
    })) as unknown as {
      pipelineId: string;
      roles?: string[];
      executionPolicy: { template_json?: { specVersion?: string; nodes?: Record<string, unknown> } };
    };
    assert.equal(route.pipelineId, pipelineId);
    const template = route.executionPolicy.template_json;
    assert.ok(template?.specVersion === '1.0' && template.nodes, `${pipelineId} carries a state-machine template`);
    const errors = validateTemplate(template as never).filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], `seeded ${pipelineId} template must validate with no errors`);
  }

  const profiles = await h.api.listProfiles({ playbookId: DEFAULT_PLAYBOOK_ID, pipelineId: 'feature-development' });
  assert.deepEqual(profiles.map((profile) => profile.profileId).sort(), [
    'claude-primary-codex-review-consensus',
    'claude-standard',
    'codex-primary-claude-review-consensus',
    'codex-standard',
  ]);
});

test('M0b: the seeded default is distinct from the e2e fixture playbook', { skip: e2eSkip }, async () => {
  // Same pipeline ids, different playbooks → distinct row ids (scoped by playbook). Proves Group M
  // exercises the SHIPPED default, not the fixture (which Groups A–L install separately).
  const def = await h.api.simulateRoute({ title: 't', pipeline: 'feature-development', playbookId: DEFAULT_PLAYBOOK_ID });
  assert.equal((def as { playbookId: string }).playbookId, DEFAULT_PLAYBOOK_ID);
  assert.notEqual(DEFAULT_PLAYBOOK_ID, PLAYBOOK_ID, 'the default and fixture playbook ids must differ');
  assert.equal((def as { pipelineRowId: string }).pipelineRowId, `${DEFAULT_PLAYBOOK_ID}-feature-development`);
});

test('M1: a seeded feature-development run drives plan→merge to completed on real DBOS/Revisium', { skip: e2eSkip }, async () => {
  const run = await startDefaultFeatureRun(h);
  assert.equal((run.workflow as { engine?: string }).engine, 'data-driven', 'the seeded pipeline routes to the data-driven engine');

  // analyst → planReviewer → planGate → developer → codeReview → integrator(script) → pollPr(clean) →
  // mergeReadiness(clean) → mergeGate → confirmMerge. Approving both gates drives it to the
  // `succeeded` terminal. (The pollPr polls are stubbed here — runnerOverrides stub the integrator, so
  // the run skips the triage/CI-rework loop after the fresh pre-gate readiness check.)
  const terminal = await approveUntilTerminal(h.api, run.runId);
  assert.equal(terminal.state, 'completed');
  assert.deepEqual(terminal.approvedTopics, ['plan', 'merge'], 'both seeded humanGate nodes opened in order');

  // The script integrator node ran (stub → integrate_succeeded) and the run completed — via the adapter.
  await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);

  // Every capability handle on the (clean) happy path resolved to its route binding and executed. The
  // triager runs only on the review-feedback path (a review comment), so it is not exercised here.
  const roles = executedRoles(h, run.runId).map(([role]) => role);
  for (const roleId of ['analyst', 'developer', 'reviewer']) {
    assert.ok(roles.includes(roleId), `${roleId} executed via its resolved capability handle`);
  }
});

test('M1b: a seeded Codex consensus disagreement reworks and then completes', { skip: e2eSkip }, async () => {
  const run = await startDefaultProfileRun({
    title: 'E2E seeded default Codex consensus disagreement run',
    profileId: 'codex-primary-claude-review-consensus',
    coverage: coverageForScenario('M1b-profile-consensus-rework'),
    agent: {
      byRole: {
        reviewer: [
          { kind: 'verdict', verdict: 'changes_requested' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
        ],
      },
    },
  });

  const terminal = await approveUntilTerminal(h.api, run.runId);
  assert.equal(terminal.state, 'completed');
  assert.deepEqual(terminal.approvedTopics, ['plan', 'merge'], 'both seeded humanGate nodes opened in order');
  await assertEventsPresent(h.api, run.runId, ['pipeline_fork', 'run_completed']);

  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.equal(roles.filter((role) => role === 'analyst').length, 2, 'plan consensus disagreement routes back to analyst once');
  assert.equal(roles.filter((role) => role === 'reviewer').length, 6, 'two failed plan reviewers + two passing plan reviewers + two code reviewers executed');
  for (const roleId of ['analyst', 'developer', 'reviewer']) {
    assert.ok(roles.includes(roleId), `${roleId} executed via the Codex-bound route binding`);
  }
});

test('M1c: a seeded Codex standard profile completes the single-review signature', { skip: e2eSkip }, async () => {
  const run = await startDefaultProfileRun({
    title: 'E2E seeded default Codex standard profile run',
    profileId: 'codex-standard',
    coverage: coverageForScenario('M1-profile-single'),
  });

  const terminal = await approveUntilTerminal(h.api, run.runId);
  assert.equal(terminal.state, 'completed');
  assert.deepEqual(terminal.approvedTopics, ['plan', 'merge'], 'both seeded humanGate nodes opened in order');

  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.equal(roles.filter((role) => role === 'reviewer').length, 2, 'single-review profile executes one plan and one code reviewer');
});

test('M2: a seeded local-change run completes (developer-only, no gate)', { skip: e2eSkip }, async () => {
  const run = await startDefaultLocalChangeRun(h);
  assert.equal((run.workflow as { engine?: string }).engine, 'data-driven');

  // local-change is developer → doneEnd with NO humanGate, so it runs straight to completion.
  const state = await waitState(h.api, run.runId);
  assert.equal(state.state, 'completed', 'local-change has no gate and completes without approval');
  await assertCompleted(h.api, run.runId);

  const roles = executedRoles(h, run.runId).map(([role]) => role);
  assert.ok(roles.includes('developer'), 'the developer executed for the seeded local-change run');
  assert.ok(!roles.includes('reviewer'), 'local-change does not run a reviewer (no gate, no review node)');
});
