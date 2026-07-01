import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { Step } from '../control-plane/steps.js';
import { makeResolveCwd, makeResolveTaskCwd, makeResolveRunCwd } from '../control-plane/resolve-cwd.js';
import { getConfig } from '../config.js';
import type { AgentRunContext } from '../worker/build-context.js';
import { createRunWorkflow, type CreateRunInput, type CreateRunResult } from '../run/create-run.js';
import { listRuns, showRun, listRunEvents, listRunAttempts, getRunFailure, type RunSummary, type RunDetail, type EventSummary, type AttemptSummary } from '../run/inspect-run.js';
import { cancelRun, type CancelRunResult } from '../run/cancel-run.js';
import { failRun, type FailRunResult } from '../run/fail-run.js';
import { completeRun, type CompleteRunResult } from '../run/complete-run.js';
import { blockRun, type BlockRunResult } from '../run/block-run.js';
import { appendRunEvent, appendRunCost, appendRunAttempt, type AppendEventInput, type AppendCostInput, type AppendAttemptInput } from '../run/append-event.js';
import { appendRunOutput as appendRunOutputRow, type RunOutputRow } from '../run/run-outputs.js';
import type { IssueAction, IssueRef } from '../run/issue-ref.js';
import { REVISIUM_TRANSPORT_DRAFT } from './tokens.js';








@Injectable()
export class RunService {
  private readonly da: ControlPlaneDataAccess;

  constructor(
    @Inject(REVISIUM_TRANSPORT_DRAFT) private readonly draftTransport: ControlPlaneTransport,
  ) {
    this.da = createControlPlaneDataAccessForTransport(this.draftTransport);
  }

  createRun(input: CreateRunInput): Promise<CreateRunResult> {
    return createRunWorkflow(this.da, input);
  }

  listRuns(filter?: { status?: string; limit?: number }): Promise<RunSummary[]> {
    return listRuns(this.da, filter);
  }

  showRun(id: string): Promise<RunDetail | null> {
    return showRun(this.da, id);
  }

  listRunEvents(id: string, filter?: { type?: string; limit?: number; expand?: ('graph')[] }): Promise<EventSummary[]> {
    return listRunEvents(this.da, id, filter);
  }


  listRunAttempts(id: string, filter?: { limit?: number }): Promise<AttemptSummary[]> {
    return listRunAttempts(this.da, id, filter);
  }

  cancelRun(id: string, opts?: { now?: Date; idSuffix?: string; actor?: string; source?: string }): Promise<CancelRunResult | null> {
    return cancelRun(this.da, id, opts);
  }




  failRun(id: string, reason: string, opts?: { now?: Date; actor?: string; source?: string }): Promise<FailRunResult | null> {
    return failRun(this.da, id, reason, opts);
  }



  completeRun(
    id: string,
    opts?: { now?: Date; actor?: string; source?: string; verdict?: string; iterations?: number },
  ): Promise<CompleteRunResult | null> {
    return completeRun(this.da, id, opts);
  }



  blockRun(
    id: string,
    opts?: { now?: Date; actor?: string; source?: string; reason?: string },
  ): Promise<BlockRunResult | null> {
    return blockRun(this.da, id, opts);
  }


  getRun(id: string): Promise<ControlPlaneRow | null> {
    return this.da.getRow('task_runs', id);
  }


  getRunFailure(id: string): Promise<{ runStatus: string; reason?: string } | null> {
    return getRunFailure(this.da, id);
  }









  async loadPipelineContext(
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    modelProfile: string,
  ): Promise<{ da: ControlPlaneDataAccess; step: Step; runContext: AgentRunContext }> {
    const detail = await showRun(this.da, runId);
    if (!detail) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    }
    const runRow = await this.da.getRow('task_runs', runId);
    if (!runRow) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    }
    const taskId = detail.tasks[0]?.taskId;
    if (!taskId) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `run ${runId} has no task`);
    }
    const params = runRow.data.params;
    const step: Step = {
      id: `pstep_${fnv1a64Hex(`${runId}|${stepKey}`)}`,
      taskId,
      runId,
      role,
      kind: 'pipeline',
      status: 'running',
      input: stepInput,
      output: null,
      modelProfile,
      runAfter: '',
      attemptCount: 0,
      maxAttempts: 1,
      priority: 0,
      leaseOwner: '',
      leaseExpiresAt: '',
      deadReason: '',
    };
    return {
      da: this.da,
      step,
      runContext: {
        description: typeof runRow.data.description === 'string' ? runRow.data.description : '',
        params: params !== null && typeof params === 'object' && !Array.isArray(params)
          ? (params as Record<string, unknown>)
          : {},
      },
    };
  }




  makeResolveCwd(base = process.cwd()): (step: Step) => Promise<string> {
    return makeResolveCwd(this.da, getConfig().dataDir, base);
  }




  makeResolveRunCwd(base = process.cwd()): (runId: string, taskId: string) => Promise<string> {
    return makeResolveRunCwd(this.da, getConfig().dataDir, base);
  }




  makeResolveTaskCwd(base = process.cwd()): (taskId: string) => Promise<string> {
    return makeResolveTaskCwd(this.da, base);
  }






  async loadRunTaskContext(runId: string): Promise<{
    taskId: string;
    title: string;
    base: string;
    repoRef: string;
    issueRef?: IssueRef;
    issueAction?: IssueAction;
  }> {
    const detail = await showRun(this.da, runId);
    if (!detail) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `loadRunTaskContext: run ${runId} not found`);
    }
    const task = detail.tasks[0];
    if (!task) {
      throw new ControlPlaneError(
        'ROW_NOT_FOUND',
        `loadRunTaskContext: run ${runId} has no task`,
      );
    }
    return {
      taskId: task.taskId,
      title: task.title,
      base: 'master',
      repoRef: detail.run.repos[0] ?? '',
      ...(detail.run.issueRef ? { issueRef: detail.run.issueRef } : {}),
      ...(detail.run.issueAction ? { issueAction: detail.run.issueAction } : {}),
    };
  }



  appendEvent(input: AppendEventInput): Promise<void> {
    return appendRunEvent(this.da, input);
  }



  appendCost(input: AppendCostInput): Promise<void> {
    return appendRunCost(this.da, input);
  }



  appendAttempt(input: AppendAttemptInput): Promise<void> {
    return appendRunAttempt(this.da, input);
  }



  appendRunOutput(input: RunOutputRow): Promise<void> {
    return appendRunOutputRow(this.da, input);
  }
}
