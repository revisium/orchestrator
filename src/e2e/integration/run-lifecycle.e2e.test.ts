import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createIntegrationContext,
  type IntegrationContext,
} from '../support/integration-context.js';

let integration: IntegrationContext;
const PLAN_OPTIONS = ['approved'] as const;
const MERGE_OPTIONS = ['approved', 'recheck', 'override_merge', 'cancel'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  integration = await createIntegrationContext();
});

after(async () => {
  if (integration) await integration.close();
});

test('local-change: developer-only run completes and reattaches', { skip: e2eSkip }, async () => {
  const run = await integration.prepare({
    title: 'integration local-change',
    repo: 'workspace',
    pipelineId: 'local-change',
    profile: 'fixture-agent',
    developerWrite: false,
  });
  const started = await run.start();
  assert.equal(started.alreadyStarted, false);
  assert.deepEqual(started.agentBindings.map((binding) => [binding.roleId, binding.runnerId, binding.provider, binding.modelId]), [
    ['developer', 'codex', 'openai', 'gpt-5.6-luna'],
  ]);
  assert.match(started.executionPlanDigest, /^sha256:[0-9a-f]{64}$/);

  await run.settle('completed');
  await run.expectCompleted();
  await run.expectAttemptVerdicts(['approved']);
  run.expectExecutedRoles([['developer', 'codex']]);
  await run.expectEvents(['step_succeeded', 'run_completed']);
  await run.expectUsage({ inputTokens: 10, outputTokens: 5, costAmount: 0.001 });

  const reattached = await run.reattach();
  assert.equal(reattached.alreadyStarted, true);
});

test('feature-development: real host lifecycle completes and opens a PR', { skip: e2eSkip }, async () => {
  const target = integration.target();
  const run = await integration.prepare({
      title: 'integration feature-development',
      repo: target,
      pipelineId: 'feature-development',
      profile: 'fixture-agent',
    });
  const started = await run.start();
  assert.deepEqual(
    started.agentBindings.map((binding) => [binding.nodeId, binding.roleId, binding.runnerId, binding.provider, binding.modelId]),
    [
      ['analyst', 'analyst', 'codex', 'openai', 'gpt-5.6-luna'],
      ['ciRework', 'developer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['classifyRecovery', 'triager', 'codex', 'openai', 'gpt-5.6-luna'],
      ['codeReview', 'reviewer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['developer', 'developer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['planReviewer', 'reviewer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['questionReviewRework', 'developer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['reviewRework', 'developer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['reworkDeveloper', 'developer', 'codex', 'openai', 'gpt-5.6-luna'],
      ['triage', 'triager', 'codex', 'openai', 'gpt-5.6-luna'],
    ],
  );

  await run.resolveGate({ topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await run.settle('completed');
  await run.expectCompleted();
  await run.expectAttemptVerdicts(['approved', 'approved', 'approved', 'approved']);
  await run.expectEvents([
    'gate_signaled',
    'integrate_succeeded',
    'pr_polled',
    'merge_confirmed',
    'run_completed',
  ]);

  const branch = run.expectPrOpened();
  assert.deepEqual(target.baseObservation(), { branch: 'master', clean: true });
  assert.equal(target.commitsAhead(branch), 1);
  run.expectWorktreeReleased();
  await run.expectUsage({ inputTokens: 40, outputTokens: 20, costAmount: 0.004 });
});
