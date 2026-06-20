import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneChange } from '../../../control-plane/change-notifications.js';
import {
  INBOX_ITEM_ADDED_TOPIC,
  INBOX_ITEM_RESOLVED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_UPDATED_TOPIC,
} from './constants.js';
import { ControlPlaneSubscriptionBridge } from './subscription-bridge.service.js';

test('ControlPlaneSubscriptionBridge maps sealed control-plane changes to PubSub topics', async () => {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const pubSub = {
    async publish(topic: string, payload: Record<string, unknown>) {
      published.push({ topic, payload });
    },
  };
  const bridge = new ControlPlaneSubscriptionBridge(pubSub as never) as unknown as {
    handleNotification(payload: string): Promise<void>;
  };

  const base = { createdAt: '2026-06-20T10:00:00.000Z', updatedAt: '2026-06-20T10:00:00.000Z' };
  const changes: ControlPlaneChange[] = [
    {
      table: 'task_runs',
      action: 'patch',
      rowId: 'run_1',
      row: { rowId: 'run_1', data: { title: 'Build', status: 'running', priority: 1, repos: ['.'], created_at: base.createdAt } },
      emittedAt: base.createdAt,
    },
    {
      table: 'events',
      action: 'create',
      rowId: 'event_1',
      row: { rowId: 'event_1', data: { run_id: 'run_1', type: 'run_created', actor: 'test', created_at: base.createdAt, task_id: 'task_1' } },
      emittedAt: base.createdAt,
    },
    {
      table: 'inbox',
      action: 'create',
      rowId: 'inbox_1',
      row: { rowId: 'inbox_1', data: { run_id: 'run_1', kind: 'approval', title: 'Approve', status: 'pending', created_at: base.createdAt } },
      emittedAt: base.createdAt,
    },
    {
      table: 'inbox',
      action: 'patch',
      rowId: 'inbox_1',
      row: { rowId: 'inbox_1', data: { run_id: 'run_1', kind: 'approval', title: 'Approve', status: 'resolved', created_at: base.createdAt } },
      emittedAt: base.createdAt,
    },
    {
      table: 'cost_ledger',
      action: 'create',
      rowId: 'cost_1',
      row: { rowId: 'cost_1', data: { run_id: 'run_1', step_id: 'step_1', attempt_id: 'attempt_1', model_profile: 'standard', input_tokens: 1, output_tokens: 2, cost_amount: 0.01, currency: 'USD', recorded_at: base.createdAt } },
      emittedAt: base.createdAt,
    },
  ];

  for (const change of changes) {
    await bridge.handleNotification(JSON.stringify(change));
  }

  assert.deepEqual(published.map((item) => item.topic), [
    RUN_UPDATED_TOPIC,
    RUN_EVENT_APPENDED_TOPIC,
    INBOX_ITEM_ADDED_TOPIC,
    INBOX_ITEM_RESOLVED_TOPIC,
    RUN_COST_RECORDED_TOPIC,
  ]);
  assert.equal((published[0]?.payload.runUpdated as { id: string }).id, 'run_1');
  assert.equal((published[1]?.payload.runEventAppended as { runId: string }).runId, 'run_1');
  assert.equal((published[2]?.payload.inboxItemAdded as { runId: string }).runId, 'run_1');
  assert.equal((published[4]?.payload.runCostRecorded as { costAmount: number }).costAmount, 0.01);
});
