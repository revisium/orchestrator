import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  e2eSkip,
  PLAYBOOK_SOURCE,
  createRunHarness,
  closeHarness,
  createTargetRepo,
  approveUntilTerminal,
  allSteps,
  git,
  type RunHarness,
  type TargetRepo,
} from './kit/index.js';

test('real DBOS/Revisium E2E: installed playbook run completes with deterministic agent only', {
  skip: e2eSkip,
}, async () => {
  assert.ok(existsSync(PLAYBOOK_SOURCE), `playbook source must exist: ${PLAYBOOK_SOURCE}`);
  let harness: RunHarness | null = null;
  let targetRepo: TargetRepo | null = null;
  try {
    harness = await createRunHarness();
    const { api, agentCalls, developerWrites, ghCalls } = harness;

    const install = await api.installPlaybook({
      source: PLAYBOOK_SOURCE,
      name: 'revisium-agent-playbook',
      commit: true,
    });
    assert.equal(install.playbookId, 'revisium-agent-playbook');
    assert.ok(install.roles > 0, 'playbook install must load roles');
    assert.ok(install.pipelines > 0, 'playbook install must load pipelines');

    const route = await api.simulateRoute({
      repo: process.cwd(),
      title: 'E2E local-change deterministic agent',
      playbookId: 'revisium-agent-playbook',
      pipeline: 'local-change',
      params: {
        executionProfile: { runnerOverrides: { 'claude-code': 'must-not-leak' } },
        runnerOverrides: { 'claude-code': 'must-not-leak' },
      },
    });
    assert.equal(route.pipelineId, 'local-change');
    assert.deepEqual(route.roles, ['orchestrator', 'developer']);
    assert.deepEqual(route.executionProfile.runnerOverrides, {}, 'public params must not smuggle runner overrides');

    const created = await api.createRun({
      repo: process.cwd(),
      title: 'E2E local-change deterministic agent',
      description: 'Real DBOS/Revisium run; deterministic test agent replaces claude-code only.',
      scope: 'No source changes.',
      playbookId: 'revisium-agent-playbook',
      pipelineId: 'local-change',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
      start: true,
    });
    assert.equal(created.started, true);
    assert.ok('workflow' in created, 'start:true must return workflow metadata');
    assert.equal(created.workflow.alreadyStarted, false);
    assert.equal(created.workflow.route.pipelineId, 'local-change');
    assert.deepEqual(
      created.workflow.route.roleBindings.map((binding) => binding.resolvedRunnerId),
      ['stub-agent', 'stub-agent'],
    );

    const waited = await api.waitForRun({
      runId: created.runId,
      timeoutMs: 60_000,
      intervalMs: 500,
    });
    assert.equal(waited.state, 'completed');
    assert.equal(waited.runStatus, 'completed');
    assert.equal(waited.workflowStatus, 'SUCCESS');

    const detail = await api.getRun({ runId: created.runId, includeEvents: true, includeLog: true });
    assert.equal(detail.run.status, 'completed');
    assert.equal(detail.tasks[0]?.status, 'completed');
    assert.ok(allSteps(detail).every((step) => step.status !== 'ready'), 'terminal run must not leave ready steps');

    const attempts = await api.getRunLog({ runId: created.runId, limit: 10 });
    assert.equal(attempts.length, 1, 'local-change executes developer; orchestrator is routing metadata');
    assert.ok(attempts.every((attempt) => attempt.artifactRef?.startsWith('test-artifacts/')));
    assert.ok(attempts.every((attempt) => attempt.stdoutTail.includes('stdout from')));
    assert.ok(attempts.every((attempt) => attempt.stderrTail === ''));

    const events = await api.getRunEvents({ runId: created.runId, limit: 20 });
    assert.ok(events.some((event) => event.type === 'step_succeeded'), 'step_succeeded events must be visible');
    assert.ok(events.some((event) => event.type === 'run_completed'), 'run_completed event must be visible');

    const digest = await api.getRunDigest(created.runId);
    assert.equal(digest.run.status, 'completed');
    assert.equal(digest.pendingInbox.length, 0);
    assert.equal(digest.usage.inputTokens, 10);
    assert.equal(digest.usage.outputTokens, 5);
    assert.equal(digest.usage.costAmount, 0.001);

    assert.deepEqual(
      agentCalls.map((call) => [call.role, call.runner]),
      [['developer', 'script']],
    );

    const restarted = await api.startRun({
      runId: created.runId,
      route: created.workflow.route,
    });
    assert.equal(restarted.alreadyStarted, true, 'second start must reattach instead of changing workflow');

    const featureRoute = await api.simulateRoute({
      repo: process.cwd(),
      title: 'E2E feature-development deterministic agent',
      playbookId: 'revisium-agent-playbook',
      pipeline: 'feature-development',
    });
    assert.deepEqual(featureRoute.roles, ['orchestrator', 'analyst', 'reviewer', 'developer', 'integrator', 'watcher']);

    targetRepo = createTargetRepo();
    const feature = await api.createRun({
      repo: targetRepo.worktree,
      title: 'E2E feature-development deterministic agent',
      description: 'Real DBOS/Revisium gates, real git integrator, deterministic agent and fake GitHub.',
      scope: 'Only mutate the temporary e2e target repository.',
      playbookId: 'revisium-agent-playbook',
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
      start: true,
    });
    developerWrites.set(feature.runId, targetRepo.worktree);
    assert.ok('workflow' in feature, 'start:true must return workflow metadata');
    assert.deepEqual(
      feature.workflow.route.roleBindings.map((binding) => [binding.roleId, binding.resolvedRunnerId]),
      [
        ['orchestrator', 'stub-agent'],
        ['analyst', 'stub-agent'],
        ['reviewer', 'stub-agent'],
        ['developer', 'stub-agent'],
        ['integrator', 'revo-integrator'],
        ['watcher', 'stub-agent'],
      ],
    );

    const terminal = await approveUntilTerminal(api, feature.runId);
    assert.equal(terminal.state, 'completed');
    assert.deepEqual(terminal.approvedTopics, ['plan', 'merge']);

    const featureDetail = await api.getRun({ runId: feature.runId, includeEvents: true, includeLog: true });
    assert.equal(featureDetail.run.status, 'completed');
    assert.ok(allSteps(featureDetail).every((step) => step.status !== 'ready'), 'terminal gated run must not leave ready steps');

    const featureAttempts = await api.getRunLog({ runId: feature.runId, limit: 20 });
    assert.deepEqual(
      featureAttempts.map((attempt) => attempt.verdict),
      ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'],
    );
    assert.equal(featureAttempts.length, 5, 'analyst/reviewer/developer/reviewer:code/watcher attempts must be recorded');
    assert.ok(featureAttempts.every((attempt) => attempt.artifactRef?.startsWith('test-artifacts/')));

    const featureEvents = await api.getRunEvents({ runId: feature.runId, limit: 50 });
    assert.ok(featureEvents.some((event) => event.type === 'gate_signaled'), 'gate signal events must be visible');
    assert.ok(featureEvents.some((event) => event.type === 'integrate_succeeded'), 'real integrator success must be visible');
    assert.ok(featureEvents.some((event) => event.type === 'run_completed'), 'gated run completion event must be visible');

    const prListCall = ghCalls.find((call) => call[0] === 'pr' && call[1] === 'list');
    assert.ok(prListCall, 'fake gh must list existing PRs before creating');
    assert.equal(prListCall[prListCall.indexOf('--repo') + 1], 'e2e/repo');
    const branch = prListCall[prListCall.indexOf('--head') + 1];
    assert.ok(branch?.startsWith(`feat/${feature.taskId}-`), `unexpected PR head branch: ${branch}`);
    assert.ok(ghCalls.some((call) => call[0] === 'pr' && call[1] === 'create'), 'fake gh must create a draft PR');
    assert.ok(ghCalls.some((call) => call[0] === 'pr' && call[1] === 'view'), 'fake gh must read back created PR metadata');
    assert.equal(git(targetRepo.worktree, ['branch', '--show-current']).trim(), branch);
    assert.equal(git(targetRepo.worktree, ['rev-list', '--count', 'origin/master..HEAD']).trim(), '1');

    const featureDigest = await api.getRunDigest(feature.runId);
    assert.equal(featureDigest.run.status, 'completed');
    assert.equal(featureDigest.pendingInbox.length, 0);
    assert.equal(featureDigest.usage.inputTokens, 50);
    assert.equal(featureDigest.usage.outputTokens, 25);
    assert.equal(featureDigest.usage.costAmount, 0.005);
  } finally {
    await closeHarness(harness);
    if (targetRepo) targetRepo.cleanup();
  }
});
