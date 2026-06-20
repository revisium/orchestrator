import test from 'node:test';
import assert from 'node:assert/strict';
import { RUN_PROGRESS_UPDATED_TOPIC, RUN_UPDATED_TOPIC } from './constants.js';
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

  assert.deepEqual(calls, ['listRuns', 'progress:run_1', 'listRuns', 'progress:run_1']);
  assert.deepEqual(published.map((item) => item.topic), [RUN_PROGRESS_UPDATED_TOPIC, RUN_UPDATED_TOPIC]);
  assert.deepEqual((published[0]?.payload.runProgressUpdated as { graphCursor: unknown }).graphCursor, { activeNodeIds: ['developer'] });
});
