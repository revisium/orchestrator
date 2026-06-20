import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_PROGRESS_UPDATED_TOPIC, RUN_UPDATED_TOPIC, RUN_WORKFLOW_UPDATED_TOPIC } from './constants.js';
import { RunProgressSubscriptionPoller } from './run-progress-subscription-poller.service.js';

test('RunProgressSubscriptionPoller publishes progress through the runs API seam', async () => {
  const calls: string[] = [];
  const runsApi = {
    async listRuns() {
      calls.push('listRuns');
      return { edges: [{ node: { id: 'run_1', title: 'Build', status: 'running', priority: 1, repos: [], createdAt: new Date(0) } }] };
    },
    async getRunProgress(data: { runId: string }) {
      calls.push(`progress:${data.runId}`);
      return { workflowStatus: 'PENDING', graphCursor: { activeNodeIds: ['developer'] }, updatedAt: new Date(0) };
    },
    async getRunWorkflow(data: { runId: string }) {
      calls.push(`workflow:${data.runId}`);
      return { run: { id: data.runId }, nodes: [] };
    },
  };
  const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const pubSub = {
    async publish(topic: string, payload: Record<string, unknown>) {
      published.push({ topic, payload });
    },
  };
  const poller = new RunProgressSubscriptionPoller(runsApi as never, pubSub as never) as unknown as {
    tick(): Promise<void>;
  };

  await poller.tick();
  await poller.tick();

  assert.deepEqual(calls, ['listRuns', 'progress:run_1', 'workflow:run_1', 'listRuns', 'progress:run_1']);
  assert.deepEqual(published.map((item) => item.topic), [RUN_PROGRESS_UPDATED_TOPIC, RUN_UPDATED_TOPIC, RUN_WORKFLOW_UPDATED_TOPIC]);
  assert.deepEqual((published[0]?.payload.runProgressUpdated as { graphCursor: unknown }).graphCursor, { activeNodeIds: ['developer'] });
});

test('RunProgressSubscriptionPoller keeps polling when workflow publish fails for one run', async () => {
  const calls: string[] = [];
  const runsApi = {
    async listRuns() {
      return {
        edges: [
          { node: { id: 'run_1', status: 'running' } },
          { node: { id: 'run_2', status: 'running' } },
        ],
      };
    },
    async getRunProgress(data: { runId: string }) {
      calls.push(`progress:${data.runId}`);
      return { workflowStatus: 'PENDING', graphCursor: { activeNodeIds: [data.runId] }, updatedAt: new Date(0) };
    },
    async getRunWorkflow(data: { runId: string }) {
      calls.push(`workflow:${data.runId}`);
      if (data.runId === 'run_1') throw new Error('projection unavailable');
      return { run: { id: data.runId }, nodes: [] };
    },
  };
  const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const pubSub = {
    async publish(topic: string, payload: Record<string, unknown>) {
      published.push({ topic, payload });
    },
  };
  const poller = new RunProgressSubscriptionPoller(runsApi as never, pubSub as never) as unknown as {
    tick(): Promise<void>;
  };

  await poller.tick();

  assert.deepEqual(calls, ['progress:run_1', 'workflow:run_1', 'progress:run_2', 'workflow:run_2']);
  assert.equal(published.filter((item) => item.topic === RUN_WORKFLOW_UPDATED_TOPIC).length, 1);
  assert.equal((published.find((item) => item.topic === RUN_WORKFLOW_UPDATED_TOPIC)?.payload.runId as string), 'run_2');
});
