import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { getConfig } from '../config.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
import {
  RUN_REAL_E2E,
  e2eSkip,
  PLAYBOOK_ID,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  startLocalChangeRun,
  startFeatureRun,
  createTargetRepo,
  git,
  waitState,
  approveUntilTerminal,
  assertCompleted,
  assertAttemptVerdicts,
  assertEventsPresent,
  assertUsage,
  executedRoles,
  assertPrOpened,
} from './kit/index.js';

// One real DBOS/Revisium host for the whole file; tests are isolated by unique runIds.
let h: RunHarness;

before(async () => {
  if (!RUN_REAL_E2E) return; // keep `pnpm test` (unit) from booting the real stack
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

test('route: public params cannot smuggle runner overrides', { skip: e2eSkip }, async () => {
  const route = await h.api.simulateRoute({
    repo: process.cwd(),
    title: 'E2E local-change deterministic agent',
    playbookId: PLAYBOOK_ID,
    pipeline: 'local-change',
    params: {
      executionProfile: { runnerOverrides: { 'claude-code': 'must-not-leak' } },
      runnerOverrides: { 'claude-code': 'must-not-leak' },
    },
  });
  assert.equal(route.pipelineId, 'local-change');
  assert.deepEqual(route.roles, ['orchestrator', 'developer']);
  assert.deepEqual(route.executionProfile.runnerOverrides, {}, 'public params must not smuggle runner overrides');
});

test('local-change: developer-only run completes and reattaches', { skip: e2eSkip }, async () => {
  const run = await startLocalChangeRun(h);
  assert.equal(run.started, true);
  assert.equal(run.workflow.alreadyStarted, false);
  assert.deepEqual(run.workflow.route.roleBindings.map((b) => b.resolvedRunnerId), ['stub-agent', 'stub-agent']);

  const waited = await waitState(h.api, run.runId);
  assert.equal(waited.state, 'completed');
  // Not asserting waited.workflowStatus: the DBOS workflow status (PENDING→SUCCESS) lags the run row,
  // so a snapshot taken the instant the run goes terminal can still read PENDING. run.status
  // (asserted via assertCompleted) is the reliable success signal.

  await assertCompleted(h.api, run.runId);
  await assertAttemptVerdicts(h.api, run.runId, ['approved']); // local-change executes developer only
  assert.deepEqual(executedRoles(h, run.runId), [['developer', 'script']]);
  await assertEventsPresent(h.api, run.runId, ['step_succeeded', 'run_completed']);
  await assertUsage(h.api, run.runId, { inputTokens: 10, outputTokens: 5, costAmount: 0.001 });

  const restarted = await h.api.startRun({ runId: run.runId, route: run.workflow.route });
  assert.equal(restarted.alreadyStarted, true, 'second start must reattach, not change the workflow');
});

test('feature-development: plan→merge approve completes and opens a PR', { skip: e2eSkip }, async () => {
  const featureRoute = await h.api.simulateRoute({
    repo: process.cwd(),
    title: 'E2E feature-development deterministic agent',
    playbookId: PLAYBOOK_ID,
    pipeline: 'feature-development',
  });
  // plan 0018 adds the `triager` role (it runs only on the review-feedback path, not this happy path).
  assert.deepEqual(featureRoute.roles, ['orchestrator', 'analyst', 'reviewer', 'triager', 'developer', 'integrator', 'watcher']);

  const target = createTargetRepo();
  try {
    const run = await startFeatureRun(h, target);
    assert.deepEqual(
      run.workflow.route.roleBindings.map((b) => [b.roleId, b.resolvedRunnerId]),
      [
        ['orchestrator', 'stub-agent'],
        ['analyst', 'stub-agent'],
        ['reviewer', 'stub-agent'],
        ['triager', 'stub-agent'],
        ['developer', 'stub-agent'],
        ['integrator', 'revo-integrator'],
        ['watcher', 'stub-agent'],
      ],
    );

    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed');
    assert.deepEqual(terminal.approvedTopics, ['plan', 'merge']);

    await assertCompleted(h.api, run.runId);
    // analyst -> planReviewer -> developer -> codeReview -> integrator -> (pollPr clean) ->
    // mergeReadiness clean -> merge. FOUR approved agent attempts (the old watcher agent node was replaced
    // by deterministic pollPr script nodes, 0018 + issue 143).
    await assertAttemptVerdicts(h.api, run.runId, ['approved', 'approved', 'approved', 'approved']);
    // pollPr observes the PR, mergeReadiness rechecks it before the merge gate, and confirmMerge reports the PR merged.
    await assertEventsPresent(h.api, run.runId, ['gate_signaled', 'integrate_succeeded', 'pr_polled', 'merge_confirmed', 'run_completed']);

    const branch = assertPrOpened(h, run.taskId);
    // plan 0017 (per-run worktree isolation): the developer + integrator work in the run's ISOLATED
    // worktree (under the data dir), so the user's base checkout is never switched/dirtied — it stays
    // on master and clean. The feature branch + its single commit are pushed to origin FROM the worktree.
    assert.equal(git(target.worktree, ['branch', '--show-current']).trim(), 'master', 'base checkout stays on master');
    assert.equal(git(target.worktree, ['status', '--porcelain']).trim(), '', 'base checkout stays clean');
    assert.equal(git(target.worktree, ['rev-list', '--count', `origin/master..origin/${branch}`]).trim(), '1');
    // On a SUCCEEDED terminal (PR merged) the run worktree is released.
    assert.ok(!existsSync(worktreePathFor(getConfig().dataDir, run.runId)), 'worktree released after merge/succeeded');

    await assertUsage(h.api, run.runId, { inputTokens: 40, outputTokens: 20, costAmount: 0.004 });
  } finally {
    target.cleanup();
  }
});
