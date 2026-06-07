import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { Step } from '../control-plane/steps.js';
import { createRunWorkflow, type CreateRunInput, type CreateRunResult } from '../run/create-run.js';
import { listRuns, showRun, listRunEvents, type RunSummary, type RunDetail, type EventSummary } from '../run/inspect-run.js';
import { cancelRun, type CancelRunResult } from '../run/cancel-run.js';
import { appendRunEvent, appendRunCost, type AppendEventInput, type AppendCostInput } from '../run/append-event.js';
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

  cancelRun(id: string, opts?: { now?: Date; idSuffix?: string }): Promise<CancelRunResult | null> {
    return cancelRun(this.da, id, opts);
  }

  /** Expose getRun for events pre-check (run not found guard in CLI). */
  getRun(id: string): Promise<ControlPlaneRow | null> {
    return this.da.getRow('task_runs', id);
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
}
