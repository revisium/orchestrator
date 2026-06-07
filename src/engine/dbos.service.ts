/**
 * DbosService — the engine layer owns all @dbos-inc/dbos-sdk imports.
 *
 * This file (`dbos.service.ts`) is the primary importer; `engine/types.ts` re-exports
 * type-only symbols (`WorkflowHandle`) so pipeline callers can annotate return types
 * without importing from @dbos-inc directly. `src/pipeline/*` must import ZERO @dbos-inc.
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
import { DBOS, WorkflowQueue, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
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

  /** Registered WorkflowQueues — guarded map to ensure idempotent registration. */
  private readonly queues = new Map<string, WorkflowQueue>();

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
    // Capture step references via .bind(this) so DBOS sees stable registered functions,
    // not closures that close over `this` directly (avoids S7740 "do not assign this to self").
    const markStepBound = this.markStep.bind(this);
    const sleepStepBound = this.sleepStep.bind(this);
    this.pingWorkflow = DBOS.registerWorkflow(
      async function pingImpl(
        workflowID: string,
        sleepMs: number,
        markerFile: string,
      ): Promise<PingResult> {
        const markerCount = await markStepBound(workflowID, markerFile);
        await sleepStepBound(sleepMs);
        return { workflowID, markerCount };
      },
      { name: 'pingImpl', className: 'DbosService' },
    );
  }

  // ── Generic engine verbs (M1 — DBOS seal, TASK 0003) ───────────────────────
  //
  // `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk`. These verbs expose the minimal
  // surface needed for the pipeline module: register a step/workflow (returns the
  // DBOS-wrapped fn with the same signature), register a queue (idempotent), and enqueue
  // a workflow by ID + queue name.
  //
  // `name` format: 'ClassName.methodName' — split on the LAST dot to fill DBOS's
  // { name, className } (matching how dev:ping uses { name:'pingImpl', className:'DbosService' }).
  // Stable across releases — the recovery seam binds on name+className.

  /**
   * Register a plain async function as a DBOS step.
   * Returns the DBOS-wrapped function with the same call signature.
   * Call in the consumer's constructor, BEFORE DBOS.launch().
   */
  registerStep<A extends unknown[], R>(
    name: string,
    fn: (...a: A) => Promise<R>,
  ): (...a: A) => Promise<R> {
    const lastDot = name.lastIndexOf('.');
    const className = lastDot >= 0 ? name.slice(0, lastDot) : 'Pipeline';
    const methodName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
    return DBOS.registerStep(fn, { name: methodName, className });
  }

  /**
   * Register a plain async function as a DBOS workflow.
   * Returns the DBOS-wrapped function with the same call signature.
   * Call in the consumer's constructor, BEFORE DBOS.launch().
   */
  registerWorkflow<A extends unknown[], R>(
    name: string,
    fn: (...a: A) => Promise<R>,
  ): (...a: A) => Promise<R> {
    const lastDot = name.lastIndexOf('.');
    const className = lastDot >= 0 ? name.slice(0, lastDot) : 'Pipeline';
    const methodName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
    return DBOS.registerWorkflow(fn, { name: methodName, className });
  }

  /**
   * Construct and register a WorkflowQueue (idempotent — Map-guarded).
   * The ONLY place `new WorkflowQueue(...)` is called, keeping @dbos-inc inside this file.
   * Call before DBOS.launch().
   */
  registerQueue(name: string, opts: { concurrency?: number; workerConcurrency?: number }): void {
    if (!this.queues.has(name)) {
      this.queues.set(name, new WorkflowQueue(name, opts));
    }
  }

  /**
   * Enqueue a registered workflow with a stable workflowID and queue name.
   * Idempotent by workflowID: if a workflow with the same id already exists, DBOS returns
   * a handle to the existing workflow and does NOT start a second run.
   *
   * Generic over the workflow's arg tuple A so it accepts any registered fn signature.
   *
   * @param fn        - The DBOS-wrapped workflow function (returned by registerWorkflow).
   * @param workflowID - Stable dedup key (e.g. the runId).
   * @param queueName  - Name of the queue to enqueue on.
   * @param args       - Arguments forwarded to the workflow (persisted as durable input).
   */
  startWorkflowOn<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
    workflowID: string,
    queueName: string,
    ...args: A
  ): Promise<WorkflowHandle<R>> {
    return DBOS.startWorkflow(fn, { workflowID, queueName })(...args);
  }

  // ── end generic engine verbs ────────────────────────────────────────────────

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
   *
   * CR3: The effective workflow ID is decided in ONE place (the CLI layer — dev.ts) and
   * must always be non-empty before calling this method. This keeps StartWorkflowParams
   * and the workflow args consistent: both see the same stable, non-empty id, so
   * PingResult.workflowID and marker identity are never empty.
   *
   * @param workflowID  - Stable, non-empty id (sanitized by the caller — CR1/CR3).
   * @param sleepMs     - Duration of step2 sleep (default 15 000 ms).
   * @param markerFile  - Path to the durable marker file written by step1.
   */
  async startPingWorkflow(
    workflowID: string,
    sleepMs: number,
    markerFile: string,
  ): Promise<WorkflowHandle<PingResult>> {
    return DBOS.startWorkflow(this.pingWorkflow, { workflowID })(workflowID, sleepMs, markerFile);
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
   *
   * @deprecated Use `waitForWorkflowResult<T>` for typed workflows. Kept for ping backward compat.
   */
  async waitForWorkflow(id: string): Promise<PingResult | null> {
    const handle = DBOS.retrieveWorkflow<PingResult>(id);
    return handle.getResult();
  }

  /**
   * Generic recover-and-wait: retrieve a workflow handle by id and await its typed result.
   * Used by `run start` to await workflow completion (C2 fix — so the CLI process does not
   * close before the workflow finishes). Also used for crash-resume: re-running `run start <id>`
   * re-attaches to the existing handle and waits for it to finish — not a double-enqueue.
   *
   * `DBOS.retrieveWorkflow()` always returns a handle (even for a workflow that does not exist yet),
   * so callers should confirm the workflow exists (via `getWorkflowStatus`) before calling this if
   * they want to distinguish "not found" from "in progress".
   */
  async waitForWorkflowResult<T>(id: string): Promise<T | null> {
    const handle = DBOS.retrieveWorkflow<T>(id);
    return handle.getResult();
  }
}
