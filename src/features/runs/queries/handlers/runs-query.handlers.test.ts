import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetAgentActivityQuery } from '../impl/get-agent-activity.query.js';
import { GetAgentAttemptsQuery } from '../impl/get-agent-attempts.query.js';
import { GetAgentLogQuery } from '../impl/get-agent-log.query.js';
import { GetRunAttemptsQuery } from '../impl/get-run-attempts.query.js';
import { GetRunDigestQuery } from '../impl/get-run-digest.query.js';
import { GetRunEventsQuery } from '../impl/get-run-events.query.js';
import { GetRunProgressQuery } from '../impl/get-run-progress.query.js';
import { GetRunQuery } from '../impl/get-run.query.js';
import { GetRunWorkflowQuery } from '../impl/get-run-workflow.query.js';
import { ListRunsQuery } from '../impl/list-runs.query.js';
import { SimulateRouteQuery } from '../impl/simulate-route.query.js';
import {
  GetAgentActivityHandler,
  GetAgentAttemptsHandler,
  GetAgentLogHandler,
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
    async getAgentActivity(runId: string) {
      assert.equal(runId, 'run_1');
      return {
        runId: 'run_1',
        aggregateStatus: 'running',
        latestActivityAt: '2026-06-20T10:00:10.000Z',
        latestOutputAt: '2026-06-20T10:00:09.000Z',
        attempts: [{
          runId: 'run_1',
          attemptId: 'agent_attempt_1',
          stepId: 'step_1',
          stepKey: 'developer',
          role: 'developer',
          runner: 'claude-code',
          status: 'running',
          startedAt: '2026-06-20T10:00:00.000Z',
          lastEventAt: '2026-06-20T10:00:10.000Z',
          lastOutputAt: '2026-06-20T10:00:09.000Z',
          lastStream: 'agent-jsonl',
          stdoutBytes: 12,
          stderrBytes: 3,
          eventCount: 2,
          artifactRef: 'run_1/agent_attempt_1',
          exitCode: null,
          timedOut: false,
          error: 'redacted',
        }],
      };
    },
    async getAgentAttempts(runId: string) {
      assert.equal(runId, 'run_1');
      return [{
        runId: 'run_1',
        attemptId: 'agent_attempt_1',
        stepId: 'step_1',
        stepKey: 'developer',
        role: 'developer',
        runner: 'claude-code',
        artifactRef: 'run_1/agent_attempt_1',
        startedAt: '2026-06-20T10:00:00.000Z',
        finishedAt: '2026-06-20T10:01:00.000Z',
        status: 'succeeded',
        exitCode: 0,
        timedOut: false,
        stdoutBytes: 12,
        stderrBytes: 3,
      }];
    },
    async getAgentLog(input: unknown) {
      assert.deepEqual(input, {
        runId: 'run_1',
        attemptId: 'agent_attempt_1',
        stream: 'stdout',
        offsetBytes: 0,
        limitBytes: 12,
        tailBytes: undefined,
      });
      return {
        runId: 'run_1',
        attemptId: 'agent_attempt_1',
        stream: 'stdout',
        offsetBytes: 0,
        nextOffsetBytes: 12,
        totalBytes: 12,
        truncated: false,
        content: 'hello',
      };
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
  const activity = await new GetAgentActivityHandler(api).execute(new GetAgentActivityQuery({ runId: 'run_1' }));
  assert.equal(activity?.attempts[0]?.lastStream, 'agent_jsonl');
  assert.equal(activity?.latestActivityAt.toISOString(), '2026-06-20T10:00:10.000Z');
  const agentAttempts = await new GetAgentAttemptsHandler(api).execute(new GetAgentAttemptsQuery({ runId: 'run_1' }));
  assert.equal(agentAttempts[0]?.attemptId, 'agent_attempt_1');
  assert.equal(agentAttempts[0]?.finishedAt?.toISOString(), '2026-06-20T10:01:00.000Z');
  const log = await new GetAgentLogHandler(api).execute(new GetAgentLogQuery({
    runId: 'run_1',
    attemptId: 'agent_attempt_1',
    stream: 'stdout',
    offsetBytes: 0,
    limitBytes: 12,
  }));
  assert.equal(log.content, 'hello');
  assert.equal((await new GetRunProgressHandler(api).execute(new GetRunProgressQuery({ runId: 'run_1' }))).workflowStatus, 'PENDING');
  assert.equal((await new GetRunDigestHandler(api).execute(new GetRunDigestQuery({ runId: 'run_1' }))).latestEvents[0]?.id, 'event_1');
  assert.equal((await new GetRunWorkflowHandler(api).execute(new GetRunWorkflowQuery({ runId: 'run_1' }))).run.status, 'blocked');
  assert.deepEqual(await new SimulateRouteHandler(api).execute(new SimulateRouteQuery({ title: 'Build', repo: '.' })), { pipelineId: 'default' });
});
