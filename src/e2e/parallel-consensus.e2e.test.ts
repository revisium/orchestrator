import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  PLAYBOOK_SOURCE,
  createRunHarness,
  type RunHarness,
  createTargetRepo,
  type TargetRepo,
  routedScriptedAgent,
  type AgentSpec,
  waitState,
  assertEventsPresent,
} from './kit/index.js';

// Group N — DATA-DRIVEN PARALLEL CONSENSUS.
//
// This is a narrow regression test for the runtime fork/join adapter: a `parallel` node must execute both
// reviewer branches, each branch must persist its own reviewer attempt/result, and only then may the `all`
// join continue to the terminal.

const PLAYBOOK_ID = 'revisium-agent-playbook-parallel-e2e';
const PIPELINE_ID = 'parallel-review-consensus-e2e';
const specs = new Map<string, AgentSpec>();

let h: RunHarness;
let target: TargetRepo;

async function installParallelPlaybook(harness: RunHarness): Promise<void> {
  // Skip-if-present is mandatory, not an optimization: e2e-setup pre-installs this playbook, and a
  // repeated install here UPSERTS rows and COMMITS the shared draft mid-suite — every concurrently
  // running file's cached draft revision then dies with "The revision is not a draft".
  const installed = await harness.api.listPlaybooks();
  if (installed.some((p) => p.id === PLAYBOOK_ID)) return;
  try {
    const install = await harness.api.installPlaybook({
      source: PLAYBOOK_SOURCE,
      name: PLAYBOOK_ID,
      version: 'parallel-consensus-e2e',
      commit: true,
    });
    assert.equal(install.playbookId, PLAYBOOK_ID);
    assert.ok(install.pipelines > 0, 'fixture playbook install must load pipelines');
  } catch (err) {
    if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
  }
}

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: (sink) => routedScriptedAgent(specs, sink) });
  await installParallelPlaybook(h);
  target = createTargetRepo();
});

after(async () => {
  if (target) target.cleanup();
  if (h) await h.close();
});

test('N1: parallel consensus review returns two reviewer results before the all-join completes', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E parallel consensus review',
    description: 'Two reviewer branches should execute independently before the all-join.',
    scope: 'parallel consensus e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  specs.set(created.runId, {
    byRole: {
      reviewer: [
        { kind: 'domainVerdict', verdict: 'approved' },
        { kind: 'domainVerdict', verdict: 'approved' },
      ],
    },
  });

  const started = await h.api.startRun({ runId: created.runId });
  assert.equal((started as { engine?: string }).engine, 'data-driven', 'startRun selected the data-driven adapter');

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, 'completed');
  await assertEventsPresent(h.api, created.runId, ['pipeline_fork', 'run_completed']);

  const reviewerCalls = h.agentCalls.filter((call) => call.runId === created.runId && call.role === 'reviewer');
  assert.equal(reviewerCalls.length, 2, 'both reviewer branches must call the runner');

  const workflow = await h.api.getRunWorkflow(created.runId);
  const reviewNodes = workflow.nodes
    .filter((node) => node.roleId === 'reviewer')
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    reviewNodes.map((node) => ({ id: node.id, attemptCount: node.attemptCount, verdict: node.verdict })),
    [
      { id: 'primaryReview', attemptCount: 1, verdict: 'approved' },
      { id: 'secondaryReview', attemptCount: 1, verdict: 'approved' },
    ],
  );

  assert.equal(workflow.attempts.length, 2, 'consensus must persist two reviewer attempt results');
  assert.deepEqual(
    workflow.attempts.map((attempt) => attempt.verdict).sort(),
    ['approved', 'approved'],
  );
  assert.ok(
    workflow.attempts.every((attempt) => attempt.artifactRef?.startsWith('test-artifacts/')),
    'each reviewer result carries its own process artifact',
  );
});

test('N2: parallel consensus blocks when exactly one reviewer is non-approved', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E parallel consensus mixed review',
    description: 'A single non-approved reviewer must be enough to block the consensus router.',
    scope: 'parallel consensus negative e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  specs.set(created.runId, {
    byRole: {
      reviewer: [
        { kind: 'domainVerdict', verdict: 'changes_requested' },
        { kind: 'domainVerdict', verdict: 'approved' },
      ],
    },
  });

  await h.api.startRun({ runId: created.runId });

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, 'blocked', 'mixed consensus must not pass when the second branch approves');

  const workflow = await h.api.getRunWorkflow(created.runId);
  const reviewNodes = workflow.nodes
    .filter((node) => node.roleId === 'reviewer')
    .sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    reviewNodes.map((node) => ({ id: node.id, attemptCount: node.attemptCount })),
    [{ id: 'primaryReview', attemptCount: 1 }, { id: 'secondaryReview', attemptCount: 1 }],
  );
  assert.deepEqual(reviewNodes.map((node) => node.verdict).sort(), ['approved', 'changes_requested']);
});

test('N3: parallel consensus blocks when both reviewers are non-approved', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E parallel consensus rejected review',
    description: 'Two non-approved reviewers should block after both branch results are persisted.',
    scope: 'parallel consensus rejected e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  specs.set(created.runId, {
    byRole: {
      reviewer: [
        { kind: 'domainVerdict', verdict: 'changes_requested' },
        { kind: 'domainVerdict', verdict: 'blocker' },
      ],
    },
  });

  await h.api.startRun({ runId: created.runId });

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, 'blocked');
  assert.equal(
    h.agentCalls.filter((call) => call.runId === created.runId && call.role === 'reviewer').length,
    2,
    'both reviewers still run before the consensus blocks',
  );
});

test('N4: parallel consensus passes when reviewers return approved plus clean', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E parallel consensus approved clean review',
    description: 'Approved plus clean should satisfy the consensus pass set.',
    scope: 'parallel consensus approved clean e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  specs.set(created.runId, {
    byRole: {
      reviewer: [
        { kind: 'domainVerdict', verdict: 'approved' },
        { kind: 'domainVerdict', verdict: 'clean' },
      ],
    },
  });

  await h.api.startRun({ runId: created.runId });

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, 'completed');

  const workflow = await h.api.getRunWorkflow(created.runId);
  const reviewNodes = workflow.nodes.filter((node) => node.roleId === 'reviewer');
  assert.deepEqual(reviewNodes.map((node) => node.verdict).sort(), ['approved', 'clean']);
});
