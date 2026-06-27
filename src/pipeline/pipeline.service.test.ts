import test from 'node:test';
import assert from 'node:assert/strict';
import { featureDevelopment } from '../pipeline-core/kit/fixtures.js';
import type { RouteDecision } from './route-contract.js';
import {
  type DataDrivenResult,
  type DataDrivenTaskOpts,
  type RunnerTransientRetryPolicy,
} from './data-driven-task.workflow.js';
import { PipelineService } from './pipeline.service.js';

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function buildStartDataDrivenTaskSubject() {
  let capturedOpts: DataDrivenTaskOpts | undefined;
  let startCalls = 0;
  const dataDrivenTaskFn = async (runId: string): Promise<DataDrivenResult> => ({
    runId,
    status: 'succeeded',
    verdict: 'approved',
    steps: 0,
  });
  const dbos = {
    startWorkflowOn: async (
      fn: typeof dataDrivenTaskFn,
      workflowID: string,
      queueName: string,
      runId: string,
      opts: DataDrivenTaskOpts,
    ) => {
      startCalls++;
      capturedOpts = opts;
      return { workflowID, queueName, runId, fn };
    },
  };
  const subject = Object.create(PipelineService.prototype) as PipelineService;
  Object.assign(subject as unknown as { dbos: typeof dbos; dataDrivenTaskFn: typeof dataDrivenTaskFn }, {
    dbos,
    dataDrivenTaskFn,
  });
  return {
    subject,
    get capturedOpts() {
      return capturedOpts;
    },
    get startCalls() {
      return startCalls;
    },
  };
}

test('startDataDrivenTask pins the resolved transient retry policy before DBOS enqueue', async () => {
  const oldMaxAttempts = process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'];
  const oldBackoff = process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'];
  const harness = buildStartDataDrivenTaskSubject();

  try {
    process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'] = '3';
    process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'] = '0';
    const route = {} as RouteDecision;
    const template = featureDevelopment();

    await harness.subject.startDataDrivenTask('run-policy-pin', { route, template });

    assert.ok(harness.capturedOpts);
    assert.strictEqual(harness.capturedOpts.route, route);
    assert.strictEqual(harness.capturedOpts.template, template);
    assert.deepEqual(harness.capturedOpts.runnerRetryPolicy, { maxAttempts: 3, backoffMs: 0 });
  } finally {
    restoreEnvVar('REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS', oldMaxAttempts);
    restoreEnvVar('REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS', oldBackoff);
  }
});

test('startDataDrivenTask validates explicit transient retry policy overrides before enqueue', async () => {
  const validHarness = buildStartDataDrivenTaskSubject();
  await validHarness.subject.startDataDrivenTask('run-policy-explicit', {
    route: {} as RouteDecision,
    template: featureDevelopment(),
    runnerRetryPolicy: { maxAttempts: 4, backoffMs: 5 },
  });
  assert.deepEqual(validHarness.capturedOpts?.runnerRetryPolicy, { maxAttempts: 4, backoffMs: 5 });

  const cases: Array<{ policy: RunnerTransientRetryPolicy; message: RegExp }> = [
    { policy: { maxAttempts: 0, backoffMs: 0 }, message: /runnerRetryPolicy\.maxAttempts must be a positive integer/ },
    { policy: { maxAttempts: 2, backoffMs: -1 }, message: /runnerRetryPolicy\.backoffMs must be a non-negative integer/ },
  ];

  for (const c of cases) {
    const harness = buildStartDataDrivenTaskSubject();
    assert.throws(
      () => harness.subject.startDataDrivenTask('run-policy-invalid', {
        route: {} as RouteDecision,
        template: featureDevelopment(),
        runnerRetryPolicy: c.policy,
      }),
      c.message,
    );
    assert.equal(harness.startCalls, 0, 'invalid explicit policy is rejected before DBOS enqueue');
  }
});
