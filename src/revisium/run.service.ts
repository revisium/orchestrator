import { Injectable, Inject } from '@nestjs/common';
import type { ControlPlaneTransport, ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/data-access.js';
import { createControlPlaneDataAccessForTransport } from '../control-plane/data-access.js';
import { createRunWorkflow, type CreateRunInput, type CreateRunResult } from '../run/create-run.js';
import { listRuns, showRun, listRunEvents, type RunSummary, type RunDetail, type EventSummary } from '../run/inspect-run.js';
import { cancelRun, type CancelRunResult } from '../run/cancel-run.js';
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
}
