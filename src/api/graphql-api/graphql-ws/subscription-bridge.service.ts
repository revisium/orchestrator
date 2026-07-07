import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import pg from 'pg';
import { PubSub } from 'graphql-subscriptions';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import {
  CONTROL_PLANE_CHANGE_CHANNEL,
  controlPlaneNotificationDatabaseUrl,
  type ControlPlaneChange,
} from '../../../control-plane/change-notifications.js';
import type { ControlPlaneDataAccess } from '../../../control-plane/data-access.js';
import { createPrismaRuntimeDataAccess } from '../../../run/prisma-runtime-data-access.js';
import { RevoPrismaService } from '../../../storage/revo-prisma.service.js';
import {
  APP_PUB_SUB,
  INBOX_ITEM_ADDED_TOPIC,
  INBOX_ITEM_RESOLVED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_UPDATED_TOPIC,
  RUN_WORKFLOW_UPDATED_TOPIC,
} from './constants.js';
import {
  changeRunId,
  mapInboxRow,
  mapRunCostRow,
  mapRunEventRow,
  mapRunRow,
} from './subscription-mappers.js';

@Injectable()
export class ControlPlaneSubscriptionBridge
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ControlPlaneSubscriptionBridge.name);
  private client: pg.Client | null = null;
  private runtimeDataAccess?: ControlPlaneDataAccess;

  constructor(
    @Inject(APP_PUB_SUB) private readonly pubSub: PubSub,
    @Inject(RunsApiService) private readonly runsApi: RunsApiService,
    @Optional()
    @Inject(RevoPrismaService)
    private readonly prisma?: RevoPrismaService,
  ) {}

  async onModuleInit() {
    let client: pg.Client | null = null;
    try {
      client = new pg.Client({
        connectionString: await controlPlaneNotificationDatabaseUrl(),
      });
      await client.connect();
      await client.query(`LISTEN ${CONTROL_PLANE_CHANGE_CHANNEL}`);
    } catch (error) {
      this.logger.warn(
        `Control-plane LISTEN setup skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      await client?.end().catch(() => undefined);
      return;
    }
    client.on(
      'notification',
      (message) => void this.handleNotification(message.payload),
    );
    client.on('error', (error) =>
      this.logger.warn(`Control-plane LISTEN error: ${error.message}`),
    );
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
    const hydratedChange = await this.withRehydratedRow(change);
    if (hydratedChange.table === 'task_runs') {
      await this.publishRunChange(hydratedChange);
      return;
    }
    if (
      hydratedChange.table === 'events' &&
      hydratedChange.action === 'create'
    ) {
      await this.publishEventChange(hydratedChange);
      return;
    }
    if (
      hydratedChange.table === 'inbox' &&
      hydratedChange.action === 'create'
    ) {
      await this.publishInboxAdded(hydratedChange);
      return;
    }
    if (
      hydratedChange.table === 'inbox' &&
      hydratedChange.row?.data.status === 'resolved'
    ) {
      await this.publishInboxResolved(hydratedChange);
      return;
    }
    if (
      hydratedChange.table === 'cost_ledger' &&
      hydratedChange.action === 'create'
    ) {
      await this.publishCostChange(hydratedChange);
      return;
    }
    const runId = changeRunId(hydratedChange);
    if (runId) {
      await this.publishWorkflow(runId);
    }
  }

  private dataAccess(): ControlPlaneDataAccess | undefined {
    if (!this.prisma) return undefined;
    this.runtimeDataAccess ??= createPrismaRuntimeDataAccess(this.prisma);
    return this.runtimeDataAccess;
  }

  private async withRehydratedRow(
    change: ControlPlaneChange,
  ): Promise<ControlPlaneChange> {
    if (change.row || !change.rowOmitted) return change;
    const dataAccess = this.dataAccess();
    if (!dataAccess) return change;
    try {
      const row = await dataAccess.getRow(change.table, change.rowId);
      return row ? { ...change, row } : change;
    } catch (error) {
      this.logger.warn(
        `Control-plane notification row rehydrate skipped for ${change.table}/${change.rowId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return change;
    }
  }

  private async publishRunChange(change: ControlPlaneChange): Promise<void> {
    if (change.row) {
      await this.pubSub.publish(RUN_UPDATED_TOPIC, {
        runUpdated: mapRunRow(change.row),
        runId: change.rowId,
      });
    }
    await this.publishWorkflow(change.rowId);
  }

  private async publishEventChange(change: ControlPlaneChange): Promise<void> {
    const runId = changeRunId(change);
    if (change.row) {
      await this.pubSub.publish(RUN_EVENT_APPENDED_TOPIC, {
        runEventAppended: mapRunEventRow(change.row),
        runId,
      });
    }
    await this.publishWorkflow(runId);
  }

  private async publishInboxAdded(change: ControlPlaneChange): Promise<void> {
    const runId = changeRunId(change);
    if (change.row) {
      await this.pubSub.publish(INBOX_ITEM_ADDED_TOPIC, {
        inboxItemAdded: mapInboxRow(change.row),
        runId,
      });
    }
    await this.publishWorkflow(runId);
  }

  private async publishInboxResolved(
    change: ControlPlaneChange,
  ): Promise<void> {
    const runId = changeRunId(change);
    if (change.row) {
      await this.pubSub.publish(INBOX_ITEM_RESOLVED_TOPIC, {
        inboxItemResolved: mapInboxRow(change.row),
        runId,
      });
    }
    await this.publishWorkflow(runId);
  }

  private async publishCostChange(change: ControlPlaneChange): Promise<void> {
    const runId = changeRunId(change);
    if (change.row) {
      await this.pubSub.publish(RUN_COST_RECORDED_TOPIC, {
        runCostRecorded: mapRunCostRow(change.row),
        runId,
      });
    }
    await this.publishWorkflow(runId);
  }

  private async publishWorkflow(runId: string): Promise<void> {
    if (!runId) return;
    try {
      const workflow = await this.runsApi.getRunWorkflow({ runId });
      await this.pubSub.publish(RUN_WORKFLOW_UPDATED_TOPIC, {
        runWorkflowUpdated: workflow,
        runId,
      });
    } catch (error) {
      this.logger.warn(
        `Run workflow subscription publish skipped for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
