import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createIntegrationContext,
  DEFAULT_PLAYBOOK_ID,
  type IntegrationContext,
  type IntegrationTarget,
} from '../support/integration-context.js';

let integration: IntegrationContext;
let target: IntegrationTarget;
const PLAN_OPTIONS = ['approved', 'rework', 'cancel'] as const;
const MERGE_OPTIONS = [
  'approved',
  'recheck',
  'address_review_threads',
  'return_to_development',
  'override_merge',
  'cancel',
] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  integration = await createIntegrationContext();
  target = integration.target();
});

after(async () => {
  if (integration) await integration.close();
});

test('M1: the shipped feature-development pipeline completes on the real host', { skip: e2eSkip }, async () => {
  const run = await integration.prepare({
    title: 'M1: shipped default feature-development',
    repo: target,
    playbookId: DEFAULT_PLAYBOOK_ID,
    pipelineId: 'feature-development',
    profile: 'default-full',
  });
  const started = await run.start();
  assert.equal(started.engine, 'data-driven');

  await run.resolveGate({ topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' });
  await run.resolveGate({ topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' });
  await run.settle('completed');
  await run.expectEvents(['integrate_succeeded', 'run_completed']);
  for (const role of ['analyst', 'developer', 'reviewer']) {
    run.expectRoleExecuted(role);
  }
});
