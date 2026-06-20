import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import { APP_PUB_SUB, RUN_PROGRESS_UPDATED_TOPIC, RUN_UPDATED_TOPIC, RUN_WORKFLOW_UPDATED_TOPIC } from './constants.js';

const POLL_INTERVAL_MS = 500;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'blocked']);

type RunNode = {
  id: string;
  status: string;
};

function progressKey(progress: unknown): string {
  return JSON.stringify(progress);
}

@Injectable()
export class RunProgressSubscriptionPoller implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunProgressSubscriptionPoller.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly lastProgress = new Map<string, string>();
  private readonly lastRunStatus = new Map<string, string>();

  constructor(
    @Inject(RunsApiService) private readonly runsApi: RunsApiService,
    @Inject(APP_PUB_SUB) private readonly pubSub: PubSub,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const connection = await this.runsApi.listRuns({});
      const runs = ((connection.edges ?? []) as Array<{ node?: RunNode }>).flatMap((edge) => edge.node ? [edge.node] : []);
      for (const run of runs) {
        if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
        await this.pollRun(run);
      }
    } catch {
      // The poller is an access-layer feed; host startup and CLI/MCP paths must not depend on it.
    } finally {
      this.running = false;
    }
  }

  private async pollRun(run: RunNode): Promise<void> {
    const progress = await this.runsApi.getRunProgress({ runId: run.id });
    const key = progressKey(progress);
    let workflowChanged = false;
    if (this.lastProgress.get(run.id) !== key) {
      this.lastProgress.set(run.id, key);
      await this.pubSub.publish(RUN_PROGRESS_UPDATED_TOPIC, { runProgressUpdated: progress, runId: run.id });
      workflowChanged = true;
    }
    const status = typeof progress.workflowStatus === 'string' ? progress.workflowStatus : '';
    if (status && this.lastRunStatus.get(run.id) !== status) {
      this.lastRunStatus.set(run.id, status);
      await this.pubSub.publish(RUN_UPDATED_TOPIC, { runUpdated: run, runId: run.id });
      workflowChanged = true;
    }
    if (workflowChanged) {
      await this.publishWorkflow(run.id);
    }
  }

  private async publishWorkflow(runId: string): Promise<void> {
    try {
      const workflow = await this.runsApi.getRunWorkflow({ runId });
      await this.pubSub.publish(RUN_WORKFLOW_UPDATED_TOPIC, { runWorkflowUpdated: workflow, runId });
    } catch (error) {
      this.logger.warn(`Run workflow subscription publish skipped for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
