import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { PubSub } from 'graphql-subscriptions';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import {
  CONTROL_PLANE_CHANGE_CHANNEL,
  controlPlaneNotificationDatabaseUrl,
  type ControlPlaneChange,
} from '../../../control-plane/change-notifications.js';
import {
  APP_PUB_SUB,
  INBOX_ITEM_ADDED_TOPIC,
  INBOX_ITEM_RESOLVED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_UPDATED_TOPIC,
  RUN_WORKFLOW_UPDATED_TOPIC,
} from './constants.js';
import { changeRunId, mapInboxRow, mapRunCostRow, mapRunEventRow, mapRunRow } from './subscription-mappers.js';

@Injectable()
export class ControlPlaneSubscriptionBridge implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ControlPlaneSubscriptionBridge.name);
  private client: pg.Client | null = null;

  constructor(
    @Inject(APP_PUB_SUB) private readonly pubSub: PubSub,
    @Inject(RunsApiService) private readonly runsApi: RunsApiService,
  ) {}

  async onModuleInit() {
    const url = controlPlaneNotificationDatabaseUrl();
    if (!url) return;
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query(`LISTEN ${CONTROL_PLANE_CHANGE_CHANNEL}`);
    } catch (error) {
      this.logger.warn(`Control-plane LISTEN setup skipped: ${error instanceof Error ? error.message : String(error)}`);
      await client.end().catch(() => undefined);
      return;
    }
    client.on('notification', (message) => void this.handleNotification(message.payload));
    client.on('error', (error) => this.logger.warn(`Control-plane LISTEN error: ${error.message}`));
    this.client = client;
  }

  async onModuleDestroy() {
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }

  private async handleNotification(payload: string | undefined): Promise<void> {
    if (!payload) return;
    let change: ControlPlaneChange;
    try {
      change = JSON.parse(payload) as ControlPlaneChange;
    } catch {
      return;
    }
    await this.publishChange(change);
  }

  private async publishChange(change: ControlPlaneChange): Promise<void> {
    if (change.table === 'task_runs') {
      await this.pubSub.publish(RUN_UPDATED_TOPIC, { runUpdated: mapRunRow(change.row), runId: change.rowId });
      await this.publishWorkflow(change.rowId);
      return;
    }
    if (change.table === 'events' && change.action === 'create') {
      const runId = changeRunId(change);
      await this.pubSub.publish(RUN_EVENT_APPENDED_TOPIC, { runEventAppended: mapRunEventRow(change.row), runId });
      await this.publishWorkflow(runId);
      return;
    }
    if (change.table === 'inbox' && change.action === 'create') {
      const runId = changeRunId(change);
      await this.pubSub.publish(INBOX_ITEM_ADDED_TOPIC, { inboxItemAdded: mapInboxRow(change.row), runId });
      await this.publishWorkflow(runId);
      return;
    }
    if (change.table === 'inbox' && change.row.data.status === 'resolved') {
      const runId = changeRunId(change);
      await this.pubSub.publish(INBOX_ITEM_RESOLVED_TOPIC, { inboxItemResolved: mapInboxRow(change.row), runId });
      await this.publishWorkflow(runId);
      return;
    }
    if (change.table === 'cost_ledger' && change.action === 'create') {
      const runId = changeRunId(change);
      await this.pubSub.publish(RUN_COST_RECORDED_TOPIC, { runCostRecorded: mapRunCostRow(change.row), runId });
      await this.publishWorkflow(runId);
    }
  }

  private async publishWorkflow(runId: string): Promise<void> {
    if (!runId) return;
    try {
      const workflow = await this.runsApi.getRunWorkflow({ runId });
      await this.pubSub.publish(RUN_WORKFLOW_UPDATED_TOPIC, { runWorkflowUpdated: workflow, runId });
    } catch (error) {
      // Low-level topics remain authoritative even if the aggregate projection is temporarily unavailable.
      this.logger.warn(`Run workflow subscription publish skipped for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
