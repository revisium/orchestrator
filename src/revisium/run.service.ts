import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { Step } from '../control-plane/steps.js';
import { makeResolveCwd, makeResolveTaskCwd } from '../control-plane/resolve-cwd.js';
import { createRunWorkflow, type CreateRunInput, type CreateRunResult } from '../run/create-run.js';
import { listRuns, showRun, listRunEvents, listRunAttempts, getRunFailure, type RunSummary, type RunDetail, type EventSummary, type AttemptSummary } from '../run/inspect-run.js';
import { cancelRun, type CancelRunResult } from '../run/cancel-run.js';
import { failRun, type FailRunResult } from '../run/fail-run.js';
import { completeRun, type CompleteRunResult } from '../run/complete-run.js';
import { appendRunEvent, appendRunCost, appendRunAttempt, type AppendEventInput, type AppendCostInput, type AppendAttemptInput } from '../run/append-event.js';
import { REVISIUM_TRANSPORT_DRAFT } from './tokens.js';

/**
 * RunService — thin DI wrapper over the run verbs.
 * Injects the DRAFT transport (runtime/draft table writes).
 *
 * G3: da is initialized in the constructor BODY (not a class-field initializer).
 * A class-field initializer for `da` would run before the constructor assigns the
 * `draftTransport` parameter property under ES2023/NodeNext emit, so it would read
 * this.draftTransport as undefined. The constructor-body form is safe.
 */
@Injectable()
export class RunService {
  private readonly da: ControlPlaneDataAccess;

  constructor(
    @Inject(REVISIUM_TRANSPORT_DRAFT) private readonly draftTransport: ControlPlaneTransport,
  ) {
    // Must build da in the constructor body — see G3 note above.
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

  listRunEvents(id: string, filter?: { type?: string; limit?: number }): Promise<EventSummary[]> {
    return listRunEvents(this.da, id, filter);
  }

  /** List per-attempt observability rows for a run (0008 #4 — `revo run log`). */
  listRunAttempts(id: string, filter?: { limit?: number }): Promise<AttemptSummary[]> {
    return listRunAttempts(this.da, id, filter);
  }

  cancelRun(id: string, opts?: { now?: Date; idSuffix?: string; actor?: string; source?: string }): Promise<CancelRunResult | null> {
    return cancelRun(this.da, id, opts);
  }

  /**
   * failRun — patch task_runs to `failed` + write a run_failed event (0008 #2).
   * Event-first + idempotent. Called by the pipeline workflow body on a terminal step failure
   * so the Revisium run-row reflects the failure (DBOS=progress, Revisium=meaning).
   */
  failRun(id: string, reason: string, opts?: { now?: Date; actor?: string; source?: string }): Promise<FailRunResult | null> {
    return failRun(this.da, id, reason, opts);
  }

  /**
   * completeRun — patch task_runs to `completed` + write a run_completed event.
   * Called by the pipeline workflow body after the final merge gate resolves.
   */
  completeRun(
    id: string,
    opts?: { now?: Date; actor?: string; source?: string; verdict?: string; iterations?: number },
  ): Promise<CompleteRunResult | null> {
    return completeRun(this.da, id, opts);
  }

  /** Expose getRun for events pre-check (run not found guard in CLI). */
  getRun(id: string): Promise<ControlPlaneRow | null> {
    return this.da.getRow('task_runs', id);
  }

  /** Read run-row status + the run_failed reason (0008 #2 — surfaced by `run start --wait`). */
  getRunFailure(id: string): Promise<{ runStatus: string; reason?: string } | null> {
    return getRunFailure(this.da, id);
  }

  /**
   * loadPipelineContext — M3 (TASK 0003).
   *
   * Exposes the private draft `da` via a typed verb (never widening the field to public).
   * Synthesizes an in-memory Step with the real taskId from showRun (B6: tasks[0].taskId).
   * `modelProfile` is the caller-supplied role-derived level (B7 — not hardcoded 'standard').
   *
   * B6: `RunDetail = { run, tasks: TaskSummary[] }` — taskId is on TaskSummary, NOT top-level.
   * `createRunWorkflow` writes exactly ONE task per run, so tasks[0] is THE task.
   */
  async loadPipelineContext(
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    modelProfile: string,
  ): Promise<{ da: ControlPlaneDataAccess; step: Step }> {
    const detail = await showRun(this.da, runId);
    if (!detail) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `run not found: ${runId}`);
    }
    const taskId = detail.tasks[0]?.taskId;
    if (!taskId) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `run ${runId} has no task`);
    }
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
    return { da: this.da, step };
  }

  /**
   * makeResolveCwd — STEP-level cwd resolver (M3).
   * Returns (step: Step) => Promise<string>; reads tasks.repo_ref via the draft da.
   * Used by ClaudeCodeService.
   */
  makeResolveCwd(base = process.cwd()): (step: Step) => Promise<string> {
    return makeResolveCwd(this.da, base);
  }

  /**
   * makeResolveTaskCwd — TASK-level cwd resolver (M3).
   * Returns (taskId: string) => Promise<string>; reads tasks.repo_ref via the draft da.
   * Used by IntegratorService + the live preflight (no Step available).
   */
  makeResolveTaskCwd(base = process.cwd()): (taskId: string) => Promise<string> {
    return makeResolveTaskCwd(this.da, base);
  }

  /**
   * loadRunTaskContext — B6: resolve { taskId, title, base, repoRef } from run input.
   *
   * Backed by showRun(da, runId). base is always 'master' (no base field in run input —
   * verified: create-run.ts stores only repos/repo_ref). Throws a clear error if the run
   * or its task is missing.
   */
  async loadRunTaskContext(runId: string): Promise<{
    taskId: string;
    title: string;
    base: string;
    repoRef: string;
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
      base: 'master', // MVP: base branch pinned to 'master' (see plan 0005); dynamic default-branch detection is post-MVP.
      repoRef: detail.run.repos[0] ?? '',
    };
  }

  /**
   * appendEvent — write an idempotent event to the draft events table.
   * Wraps appendRunEvent over the service's draft da.
   */
  appendEvent(input: AppendEventInput): Promise<void> {
    return appendRunEvent(this.da, input);
  }

  /**
   * appendCost — write an idempotent cost row to the draft cost_ledger table.
   * Wraps appendRunCost over the service's draft da.
   */
  appendCost(input: AppendCostInput): Promise<void> {
    return appendRunCost(this.da, input);
  }

  /**
   * appendAttempt — write an idempotent per-attempt observability row to the draft attempts table.
   * Wraps appendRunAttempt over the service's draft da (0008 #4).
   */
  appendAttempt(input: AppendAttemptInput): Promise<void> {
    return appendRunAttempt(this.da, input);
  }
}
