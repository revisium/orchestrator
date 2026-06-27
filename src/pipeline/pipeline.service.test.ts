import test from 'node:test';
import assert from 'node:assert/strict';
import { featureDevelopment } from '../pipeline-core/kit/fixtures.js';
import type { RouteDecision } from './route-contract.js';
import {
  type DataDrivenResult,
  type DataDrivenTaskOpts,
} from './data-driven-task.workflow.js';
import { PipelineService } from './pipeline.service.js';

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('startDataDrivenTask pins the resolved transient retry policy before DBOS enqueue', async () => {
  const oldMaxAttempts = process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'];
  const oldBackoff = process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'];
  let capturedOpts: DataDrivenTaskOpts | undefined;
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
      capturedOpts = opts;
      return { workflowID, queueName, runId, fn };
    },
  };
  const subject = Object.create(PipelineService.prototype) as PipelineService;
  Object.assign(subject as unknown as { dbos: typeof dbos; dataDrivenTaskFn: typeof dataDrivenTaskFn }, {
    dbos,
    dataDrivenTaskFn,
  });

  try {
    process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'] = '3';
    process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'] = '0';
    const route = {} as RouteDecision;
    const template = featureDevelopment();

    await subject.startDataDrivenTask('run-policy-pin', { route, template });

    assert.ok(capturedOpts);
    assert.strictEqual(capturedOpts.route, route);
    assert.strictEqual(capturedOpts.template, template);
    assert.deepEqual(capturedOpts.runnerRetryPolicy, { maxAttempts: 3, backoffMs: 0 });
  } finally {
    restoreEnvVar('REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS', oldMaxAttempts);
    restoreEnvVar('REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS', oldBackoff);
  }
});
