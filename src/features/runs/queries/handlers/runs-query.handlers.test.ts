import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetRunAttemptsQuery } from '../impl/get-run-attempts.query.js';
import { GetRunDigestQuery } from '../impl/get-run-digest.query.js';
import { GetRunEventsQuery } from '../impl/get-run-events.query.js';
import { GetRunProgressQuery } from '../impl/get-run-progress.query.js';
import { GetRunQuery } from '../impl/get-run.query.js';
import { GetRunWorkflowQuery } from '../impl/get-run-workflow.query.js';
import { ListRunsQuery } from '../impl/list-runs.query.js';
import { SimulateRouteQuery } from '../impl/simulate-route.query.js';
import {
  GetRunAttemptsHandler,
  GetRunDigestHandler,
  GetRunEventsHandler,
  GetRunProgressHandler,
  GetRunHandler,
  GetRunWorkflowHandler,
  ListRunsHandler,
  SimulateRouteHandler,
} from './runs-query.handlers.js';

const createdAt = new Date('2026-06-20T10:00:00.000Z');

test('runs query handlers delegate and shape run data', async () => {
  const api = {
    async listRuns(input: unknown) {
      assert.deepEqual(input, { status: 'running', limit: 51 });
      return [{ runId: 'run_1', title: 'Build', status: 'paused', priority: 2, createdAt: 'invalid' }];
    },
    async getRun(input: unknown) {
      assert.deepEqual(input, { runId: 'run_1', includeEvents: undefined });
      return { run: { runId: 'run_1', title: 'Build', status: 'running', priority: 2, createdAt, repos: ['.'] } };
    },
    async getRunEvents(input: unknown) {
      assert.deepEqual(input, { runId: 'run_1', type: 'run_created', limit: 51 });
      return [{ eventId: 'event_1', type: 'run_created', actor: 'test', createdAt, taskId: 'task_1', stepId: '', payload: { ok: true } }];
    },
    async getRunLog(input: unknown) {
      assert.deepEqual(input, { runId: 'run_1', limit: 51 });
      return [{
        attemptId: 'attempt_1',
        stepId: 'pstep_1',
        iteration: 0,
        status: 'succeeded',
        verdict: 'approved',
        modelProfile: 'standard',
        inputTokens: 3,
        outputTokens: 4,
        costAmount: 0.02,
        currency: 'USD',
        durationMs: 10,
        outputSummary: 'ok',
        artifactRef: '',
        lesson: '',
        error: '',
        startedAt: createdAt,
      }];
    },
    async getRunProgress(runId: string) {
      assert.equal(runId, 'run_1');
      return { workflowStatus: 'PENDING', graphCursor: { activeNodeIds: ['developer'] }, updatedAt: createdAt };
    },
    async getRunDigest(runId: string) {
      assert.equal(runId, 'run_1');
      return {
        run: { runId: 'run_1', title: 'Build', status: 'running', priority: 2, createdAt },
        pendingInbox: [],
        latestEvents: [{ eventId: 'event_1', type: 'run_created', actor: 'test', createdAt, taskId: 'task_1', stepId: '' }],
        usage: { inputTokens: 1, outputTokens: 2, costAmount: 0.01 },
      };
    },
    async getRunWorkflow(runId: string) {
      assert.equal(runId, 'run_1');
      return { run: { id: runId, status: 'blocked' }, nodes: [] };
    },
    async simulateRoute(input: unknown) {
      assert.deepEqual(input, { title: 'Build', repo: '.' });
      return { pipelineId: 'default' };
    },
  } as unknown as TaskControlPlaneApiService;

  const runs = await new ListRunsHandler(api).execute(new ListRunsQuery({ status: 'running' }));
  assert.equal(runs.edges[0]?.node.id, 'run_1');
  assert.equal(runs.edges[0]?.node.status, 'blocked');
  assert.equal(runs.edges[0]?.node.createdAt.getTime(), 0);
  assert.equal((await new GetRunHandler(api).execute(new GetRunQuery({ runId: 'run_1' }))).repos[0], '.');
  assert.equal((await new GetRunEventsHandler(api).execute(new GetRunEventsQuery({ runId: 'run_1', type: 'run_created' }))).edges[0]?.node.runId, 'run_1');
  const attempts = await new GetRunAttemptsHandler(api).execute(new GetRunAttemptsQuery({ runId: 'run_1' }));
  assert.equal(attempts.edges[0]?.node.id, 'attempt_1');
  assert.equal(attempts.edges[0]?.node.currency, 'USD');
  assert.equal((await new GetRunProgressHandler(api).execute(new GetRunProgressQuery({ runId: 'run_1' }))).workflowStatus, 'PENDING');
  assert.equal((await new GetRunDigestHandler(api).execute(new GetRunDigestQuery({ runId: 'run_1' }))).latestEvents[0]?.id, 'event_1');
  assert.equal((await new GetRunWorkflowHandler(api).execute(new GetRunWorkflowQuery({ runId: 'run_1' }))).run.status, 'blocked');
  assert.deepEqual(await new SimulateRouteHandler(api).execute(new SimulateRouteQuery({ title: 'Build', repo: '.' })), { pipelineId: 'default' });
});
