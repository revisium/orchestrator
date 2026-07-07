import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneChange } from '../../../control-plane/change-notifications.js';
import type { ControlPlaneDataAccess } from '../../../control-plane/data-access.js';
import { createInMemoryRuntimeDataAccess } from '../../../testing/runtime-data-access.js';
import {
  INBOX_ITEM_ADDED_TOPIC,
  INBOX_ITEM_RESOLVED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_UPDATED_TOPIC,
  RUN_WORKFLOW_UPDATED_TOPIC,
} from './constants.js';
import { ControlPlaneSubscriptionBridge } from './subscription-bridge.service.js';

test('ControlPlaneSubscriptionBridge maps sealed control-plane changes to PubSub topics', async () => {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];
  const pubSub = {
    async publish(topic: string, payload: Record<string, unknown>) {
      published.push({ topic, payload });
    },
  };
  const runsApi = {
    async getRunWorkflow(data: { runId: string }) {
      return { run: { id: data.runId }, nodes: [] };
    },
  };
  const bridge = new ControlPlaneSubscriptionBridge(
    pubSub as never,
    runsApi as never,
  ) as unknown as {
    handleNotification(payload: string): Promise<void>;
  };

  const base = {
    createdAt: '2026-06-20T10:00:00.000Z',
    updatedAt: '2026-06-20T10:00:00.000Z',
  };
  const changes: ControlPlaneChange[] = [
    {
      table: 'task_runs',
      action: 'patch',
      rowId: 'run_1',
      row: {
        rowId: 'run_1',
        data: {
          title: 'Build',
          status: 'running',
          priority: 1,
          repos: ['.'],
          created_at: base.createdAt,
        },
      },
      emittedAt: base.createdAt,
    },
    {
      table: 'events',
      action: 'create',
      rowId: 'event_1',
      row: {
        rowId: 'event_1',
        data: {
          run_id: 'run_1',
          type: 'run_created',
          actor: 'test',
          created_at: base.createdAt,
          task_id: 'task_1',
        },
      },
      emittedAt: base.createdAt,
    },
    {
      table: 'inbox',
      action: 'create',
      rowId: 'inbox_1',
      row: {
        rowId: 'inbox_1',
        data: {
          run_id: 'run_1',
          kind: 'approval',
          title: 'Approve',
          status: 'pending',
          created_at: base.createdAt,
        },
      },
      emittedAt: base.createdAt,
    },
    {
      table: 'inbox',
      action: 'patch',
      rowId: 'inbox_1',
      row: {
        rowId: 'inbox_1',
        data: {
          run_id: 'run_1',
          kind: 'approval',
          title: 'Approve',
          status: 'resolved',
          created_at: base.createdAt,
        },
      },
      emittedAt: base.createdAt,
    },
    {
      table: 'cost_ledger',
      action: 'create',
      rowId: 'cost_1',
      row: {
        rowId: 'cost_1',
        data: {
          run_id: 'run_1',
          step_id: 'step_1',
          attempt_id: 'attempt_1',
          model_profile: 'standard',
          input_tokens: 1,
          output_tokens: 2,
          cost_amount: 0.01,
          currency: 'USD',
          recorded_at: base.createdAt,
        },
      },
      emittedAt: base.createdAt,
    },
  ];

  for (const change of changes) {
    await bridge.handleNotification(JSON.stringify(change));
  }

  assert.deepEqual(
    published
      .filter((item) => item.topic !== RUN_WORKFLOW_UPDATED_TOPIC)
      .map((item) => item.topic),
    [
      RUN_UPDATED_TOPIC,
      RUN_EVENT_APPENDED_TOPIC,
      INBOX_ITEM_ADDED_TOPIC,
      INBOX_ITEM_RESOLVED_TOPIC,
      RUN_COST_RECORDED_TOPIC,
    ],
  );
  assert.equal(
    published.filter((item) => item.topic === RUN_WORKFLOW_UPDATED_TOPIC)
      .length,
    5,
  );
  assert.equal(
    (
      published.find((item) => item.topic === RUN_UPDATED_TOPIC)?.payload
        .runUpdated as { id: string }
    ).id,
    'run_1',
  );
  assert.equal(
    (
      published.find((item) => item.topic === RUN_EVENT_APPENDED_TOPIC)?.payload
        .runEventAppended as { runId: string }
    ).runId,
    'run_1',
  );
  assert.equal(
    (
      published.find((item) => item.topic === INBOX_ITEM_ADDED_TOPIC)?.payload
        .inboxItemAdded as { runId: string }
    ).runId,
    'run_1',
  );
  assert.equal(
    (
      published.find((item) => item.topic === RUN_COST_RECORDED_TOPIC)?.payload
        .runCostRecorded as { costAmount: number }
    ).costAmount,
    0.01,
  );
});

test('ControlPlaneSubscriptionBridge rehydrates omitted rows before publishing row topics', async () => {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> =
    [];
  const pubSub = {
    async publish(topic: string, payload: Record<string, unknown>) {
      published.push({ topic, payload });
    },
  };
  const runsApi = {
    async getRunWorkflow(data: { runId: string }) {
      return { run: { id: data.runId }, nodes: [] };
    },
  };
  const base = { createdAt: '2026-06-20T10:00:00.000Z' };
  const runtime = createInMemoryRuntimeDataAccess({
    events: {
      event_omitted: {
        id: 'event_omitted',
        run_id: 'run_2',
        type: 'run_created',
        actor: 'test',
        created_at: base.createdAt,
        task_id: 'task_2',
        step_id: '',
        payload: { ok: true },
      },
    },
    inbox: {
      inbox_omitted: {
        id: 'inbox_omitted',
        run_id: 'run_2',
        kind: 'approval',
        title: 'Approve',
        status: 'resolved',
        created_at: base.createdAt,
        resolved_at: base.createdAt,
        context: { runId: 'run_2' },
        answer: { approved: true },
        options: [],
      },
    },
  });
  const bridge = new ControlPlaneSubscriptionBridge(
    pubSub as never,
    runsApi as never,
    {} as never,
  ) as unknown as {
    handleNotification(payload: string): Promise<void>;
    runtimeDataAccess?: ControlPlaneDataAccess;
  };
  bridge.runtimeDataAccess = runtime.access;

  await bridge.handleNotification(
    JSON.stringify({
      table: 'events',
      action: 'create',
      rowId: 'event_omitted',
      runId: 'run_2',
      rowOmitted: true,
      emittedAt: base.createdAt,
    } satisfies ControlPlaneChange),
  );
  await bridge.handleNotification(
    JSON.stringify({
      table: 'inbox',
      action: 'patch',
      rowId: 'inbox_omitted',
      runId: 'run_2',
      rowOmitted: true,
      emittedAt: base.createdAt,
    } satisfies ControlPlaneChange),
  );

  assert.deepEqual(
    published
      .filter((item) => item.topic !== RUN_WORKFLOW_UPDATED_TOPIC)
      .map((item) => item.topic),
    [RUN_EVENT_APPENDED_TOPIC, INBOX_ITEM_RESOLVED_TOPIC],
  );
  assert.equal(
    published.filter((item) => item.topic === RUN_WORKFLOW_UPDATED_TOPIC)
      .length,
    2,
  );
  assert.deepEqual(
    (
      published.find((item) => item.topic === RUN_EVENT_APPENDED_TOPIC)?.payload
        .runEventAppended as { payload: unknown }
    ).payload,
    { ok: true },
  );
  assert.deepEqual(
    (
      published.find((item) => item.topic === INBOX_ITEM_RESOLVED_TOPIC)
        ?.payload.inboxItemResolved as { answer: unknown }
    ).answer,
    { approved: true },
  );
});
