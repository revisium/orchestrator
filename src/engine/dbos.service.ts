/**
 * DbosService — the ONLY file that imports @dbos-inc/dbos-sdk.
 *
 * Owns DBOS lifecycle (setConfig / launch / shutdown) and thin verbs
 * (startPingWorkflow / getWorkflowStatus / waitForWorkflow).
 *
 * Seam pattern: `dev:ping` is a two-step workflow registered as instance methods
 * via DBOS.registerWorkflow / DBOS.registerStep (programmatic, decorator-free).
 * Registration happens in the constructor, BEFORE DBOS.launch() — required by DBOS
 * (workflows not registered before launch() are not eligible for recovery).
 *
 * ── Confirmed SDK symbols (Task 0, @dbos-inc/dbos-sdk@4.19.8) ──────────────
 *   DBOSConfig.systemDatabaseUrl   ✓  (ТЗ expected systemDatabaseUrl — CONFIRMED)
 *   DBOS.setConfig(config)          ✓
 *   DBOS.launch()                   ✓
 *   DBOS.shutdown()                 ✓
 *   DBOS.registerWorkflow(fn, cfg)  ✓  returns wrapped fn with same signature
 *   DBOS.registerStep(fn, cfg)      ✓  returns wrapped fn with same signature
 *   DBOS.startWorkflow(fn, params)  ✓  params.workflowID ✓; returns fn(args)=>handle
 *   DBOS.getWorkflowStatus(id)      ✓  returns WorkflowStatus | null
 *   DBOS.retrieveWorkflow(id)       ✓  returns WorkflowHandle<T>; handle.getResult() ✓
 *   DBOS.sleep(ms)                  ✓
 *   ConfiguredInstance              ✓  (fallback path — not used; registerWorkflow used instead)
 *
 * ── Recovery seam ───────────────────────────────────────────────────────────
 *   On restart, DBOS.launch() auto-recovers in-flight workflows by name+className.
 *   registerWorkflow(boundFn, { name, className }) supplies stable names so DBOS
 *   can bind back to the freshly-DI-constructed DbosService singleton.
 *   If M3 (kill-mid-step test) shows recovery fails to re-bind, switch to
 *   ConfiguredInstance (documented fallback; both paths concrete — OQ-1b).
 */

import { Injectable } from '@nestjs/common';
import { DBOS, type WorkflowHandle } from '@dbos-inc/dbos-sdk';

// StartWorkflowParams is not re-exported from the SDK index; extract it from the overload.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StartWorkflowParams = NonNullable<Parameters<typeof DBOS.startWorkflow<any[], any>>[1]>;
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Return shape of the dev:ping workflow. */
export type PingResult = {
  workflowID: string;
  markerCount: number;
};

/** Registered workflow and step functions (assigned in constructor). */
type PingWorkflowFn = (workflowID: string, sleepMs: number, markerFile: string) => Promise<PingResult>;
type MarkStepFn = (workflowID: string, markerFile: string) => Promise<number>;
type SleepStepFn = (ms: number) => Promise<void>;

@Injectable()
export class DbosService {
  private launched = false;

  // Registered DBOS functions — assigned in constructor before launch().
  private readonly pingWorkflow: PingWorkflowFn;
  private readonly markStep: MarkStepFn;
  private readonly sleepStep: SleepStepFn;

  constructor() {
    // Register steps first (workflows may call them; all must be registered before launch).
    this.markStep = DBOS.registerStep(
      async function markStepImpl(workflowID: string, markerFile: string): Promise<number> {
        // Idempotent marker (F12): write exactly-once per workflowID by using 'wx' (exclusive
        // create). If the file already exists (step re-executed after a crash-before-checkpoint),
        // writeFileSync throws with EEXIST — we catch that and skip the write, ensuring the
        // marker count is always 1 for a given workflow id regardless of how many times the
        // step body runs.
        mkdirSync(dirname(markerFile), { recursive: true });
        try {
          writeFileSync(markerFile, `${workflowID}\t${new Date().toISOString()}\n`, { flag: 'wx' });
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
          // EEXIST: marker already written by a prior execution — skip (idempotent).
        }
        const content = existsSync(markerFile) ? readFileSync(markerFile, 'utf8') : '';
        return content.split('\n').filter((l) => l.trim() !== '').length;
      },
      { name: 'markStep', className: 'DbosService' },
    );

    this.sleepStep = DBOS.registerStep(
      async function sleepStepImpl(ms: number): Promise<void> {
        await DBOS.sleep(ms);
      },
      { name: 'sleepStep', className: 'DbosService' },
    );

    // Register the workflow (uses bound steps).
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.pingWorkflow = DBOS.registerWorkflow(
      async function pingImpl(
        workflowID: string,
        sleepMs: number,
        markerFile: string,
      ): Promise<PingResult> {
        const markerCount = await self.markStep(workflowID, markerFile);
        await self.sleepStep(sleepMs);
        return { workflowID, markerCount };
      },
      { name: 'pingImpl', className: 'DbosService' },
    );
  }

  /**
   * Configure DBOS with the pid-proven system database URL.
   * Must be called before launch().
   */
  setConfig(systemDatabaseUrl: string): void {
    DBOS.setConfig({ name: 'agent-orchestrator', systemDatabaseUrl });
  }

  /**
   * Launch DBOS (idempotent — guarded by `launched` flag).
   * Auto-recovers in-flight workflows.
   */
  async launch(): Promise<void> {
    if (this.launched) return;
    await DBOS.launch();
    this.launched = true;
  }

  /**
   * Shut down DBOS (no-op if never launched — E9).
   */
  async shutdown(): Promise<void> {
    if (!this.launched) return;
    await DBOS.shutdown();
    this.launched = false;
  }

  /**
   * Start the dev:ping durable workflow.
   * @param workflowID  - Stable id for the resume test (optional; DBOS assigns a UUID if omitted).
   * @param sleepMs     - Duration of step2 sleep (default 15 000 ms).
   * @param markerFile  - Path to the durable marker file written by step1.
   */
  async startPingWorkflow(
    workflowID: string | undefined,
    sleepMs: number,
    markerFile: string,
  ): Promise<WorkflowHandle<PingResult>> {
    const params: StartWorkflowParams = workflowID ? { workflowID } : {};
    return DBOS.startWorkflow(this.pingWorkflow, params)(workflowID ?? '', sleepMs, markerFile);
  }

  /**
   * Get the current status of a workflow by id.
   */
  getWorkflowStatus(id: string) {
    return DBOS.getWorkflowStatus(id);
  }

  /**
   * Recover-and-wait: retrieve an existing workflow handle and await its result.
   * Used by `dev:status <id>` — the resume-test command (E10, F2).
   * `DBOS.retrieveWorkflow()` always returns a handle even if the workflow does not exist yet.
   */
  async waitForWorkflow(id: string): Promise<PingResult | null> {
    const handle = DBOS.retrieveWorkflow<PingResult>(id);
    return handle.getResult();
  }
}
