/**
 * PipelineService — the architect→developer→reviewer→integrator DBOS workflow.
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * All DBOS interaction goes through the generic DbosService verbs.
 *
 * Registration happens in the constructor, BEFORE DBOS.launch() (mirroring dev:ping).
 *
 * B9 cost-safety: the claudeCode dep is a THROWING stub in 0003 so a non-`--stub` start
 * fails fast with RUNNER_NOT_IMPLEMENTED before any real Claude call. 0005 replaces ONLY
 * the claudeCode dep with createClaudeCodeRunner — no other change.
 *
 * B4 durable override: `developTask(runId, opts?)` is the PINNED signature (B11).
 * `opts.runnerOverride` is a DURABLE workflow argument persisted by DBOS in the input row
 * and re-supplied on recovery, so the stub selection survives a kill/restart.
 *
 * C1 architecture: the step and workflow bodies are extracted as DBOS-free builder functions
 * (`makeRunStep` / `makeDevelopTask`). PipelineService registers exactly those builders via
 * the engine seam, so tests can import and exercise the SAME production logic directly.
 */
import { Injectable } from '@nestjs/common';
import type { WorkflowHandle } from '../engine/types.js';
import { DbosService } from '../engine/dbos.service.js';
import { RolesService } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import { buildContext } from '../worker/build-context.js';
import { createRunAgent } from '../worker/runner-dispatch.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import type { RunAgent, AttemptResult } from '../worker/runner.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { AppendEventInput } from '../run/append-event.js';

/** Maximum developer/reviewer rework iterations before failing closed. */
const MAX_REVIEW_ITERATIONS = 3;

/** Queue name for the dev-tasks WorkflowQueue. */
const DEV_TASKS_QUEUE = 'dev-tasks';

/** Concurrency limit for the dev-tasks queue. */
const DEV_TASKS_CONCURRENCY = 2;

/** Returned by developTask when the pipeline completes or is blocked. */
export type DevelopResult = {
  runId: string;
  blocked: boolean;
  iterations: number;
  verdict: string;
};

/** Opts accepted by developTask — slot-1 of the PINNED arity (B11). */
export type DevelopTaskOpts = {
  runnerOverride?: 'script';
};

/**
 * verdictOf — extract the reviewer verdict from an AttemptResult.
 *
 * M2 (COMMITTED): fail-closed — missing/unknown verdict returns 'BLOCKER'.
 * Maps the seeded reviewer prompt vocabulary: APPROVE→PASS, REQUEST_CHANGES→MAJOR.
 * Explicit BLOCKER passes through. PASS and MINOR proceed.
 */
export function verdictOf(result: AttemptResult): string {
  const output = result.output;
  if (output === null || output === undefined || typeof output !== 'object') {
    return 'BLOCKER'; // fail-closed: no output → treat as blocking
  }
  const raw = (output as Record<string, unknown>).verdict;
  switch (raw) {
    case 'PASS':
      return 'PASS';
    case 'MINOR':
      return 'MINOR';
    case 'MAJOR':
      return 'MAJOR';
    case 'BLOCKER':
      return 'BLOCKER';
    case 'APPROVE':
      return 'PASS'; // seeded reviewer prompt vocabulary mapping
    case 'REQUEST_CHANGES':
      return 'MAJOR'; // seeded reviewer prompt vocabulary mapping
    default:
      return 'BLOCKER'; // fail-closed: unknown verdict → treat as blocking
  }
}

function isBlocking(verdict: string): boolean {
  return verdict === 'MAJOR' || verdict === 'BLOCKER';
}

// ── Dep shapes (C1 — used by makeRunStep / makeDevelopTask builders) ──────────

/** Dependencies for the runStep builder. */
export type RunStepDeps = {
  loadRole: RolesService['loadRole'];
  loadModelProfile: RolesService['loadModelProfile'];
  loadPipelineContext: RunService['loadPipelineContext'];
  appendEvent: (input: AppendEventInput) => Promise<void>;
  appendCost: RunService['appendCost'];
  runAgent: RunAgent;
};

/** Dependencies for the developTask builder. */
export type DevelopTaskDeps = {
  appendEvent: (input: AppendEventInput) => Promise<void>;
};

/**
 * makeRunStep — DBOS-free factory for the runStep async function.
 *
 * Returns a plain async function with the same signature as the DBOS step.
 * PipelineService passes this to `dbos.registerStep(...)` so tests can import
 * and call it directly — exercising the SAME code path as production (C1).
 */
export function makeRunStep(deps: RunStepDeps) {
  const { loadRole, loadModelProfile, loadPipelineContext, appendEvent, appendCost, runAgent } = deps;

  return async function runStepImpl(
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    runnerOverride?: 'script',
  ): Promise<AttemptResult> {
    // 1. Load the canonical role (B1: role is NEVER mutated with #k).
    const loadedRole = await loadRole(role);

    // 2. Load the model profile from the role's modelLevel (B7: not hardcoded 'standard').
    const profile = await loadModelProfile(loadedRole.modelLevel);

    // 3. Build pipeline context: synthesize in-memory Step with real taskId (M3, B6).
    const { da, step } = await loadPipelineContext(
      runId,
      role,
      stepKey,
      stepInput,
      profile.level,
    );

    // 4. Build the agent context string.
    const context = await buildContext(da, step, loadedRole);

    // 5. Deterministic, bounded attemptId (B2).
    const attemptId = `attempt_${fnv1a64Hex(`${runId}|${stepKey}`)}`;

    // 6. Apply durable runner override (B4): effectiveRunner = override ?? seeded runner.
    //    Dispatch on a role COPY so the HEAD role row is never mutated.
    const effectiveRunner = runnerOverride ?? loadedRole.runner;
    const dispatchRole = { ...loadedRole, runner: effectiveRunner as typeof loadedRole.runner };

    // 7. Run the agent.
    const result = await runAgent({ role: dispatchRole, profile, context, attemptId, step });

    // 8. Persist event to Revisium draft (idempotent — ROW_CONFLICT = no-op on replay).
    await appendEvent({
      runId,
      taskId: step.taskId,
      stepId: step.id,
      stepKey,
      type: 'step_succeeded',
      payload: { output: result.output, role, stepKey, attemptId },
    });

    // 9. Persist cost rows (idempotent by index).
    for (let i = 0; i < result.costs.length; i++) {
      const cost = result.costs[i];
      if (!cost) continue;
      await appendCost({
        runId,
        stepId: step.id,
        stepKey,
        attemptId,
        cost,
        index: i,
      });
    }

    return result;
  };
}

/**
 * makeDevelopTask — DBOS-free factory for the developTask async function.
 *
 * Returns a plain async function with the same signature as the DBOS workflow.
 * Receives the (potentially DBOS-wrapped) `runStepFn` so tests pass the plain builder
 * while production passes the DBOS-registered step — the workflow body is IDENTICAL.
 * PipelineService passes this to `dbos.registerWorkflow(...)` (C1).
 */
export function makeDevelopTask(
  runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    runnerOverride?: 'script',
  ) => Promise<AttemptResult>,
  deps: DevelopTaskDeps,
) {
  const { appendEvent } = deps;

  return async function developTaskImpl(
    runId: string,
    opts?: DevelopTaskOpts,
  ): Promise<DevelopResult> {
    const ro = opts?.runnerOverride;

    // architect step
    const architectResult = await runStepFn(
      runId,
      'architect',
      'architect',
      { phase: 'plan' },
      ro,
    );

    // developer step (first pass)
    let developerResult = await runStepFn(
      runId,
      'developer',
      'developer',
      { phase: 'implement', from: architectResult.output },
      ro,
    );

    // reviewer step (first pass)
    let reviewResult = await runStepFn(
      runId,
      'reviewer',
      'reviewer',
      { phase: 'review', from: developerResult.output },
      ro,
    );

    // bounded reviewer→developer loop (E5, E6)
    let iteration = 0;
    while (isBlocking(verdictOf(reviewResult)) && iteration < MAX_REVIEW_ITERATIONS) {
      iteration++;
      developerResult = await runStepFn(
        runId,
        'developer',
        `developer#${iteration}`,
        { phase: 'rework', feedback: reviewResult.output },
        ro,
      );
      reviewResult = await runStepFn(
        runId,
        'reviewer',
        `reviewer#${iteration}`,
        { phase: 'review', from: developerResult.output },
        ro,
      );
    }

    // Cap exhausted — still blocking: write pipeline_blocked and stop (E6).
    if (isBlocking(verdictOf(reviewResult))) {
      await appendEvent({
        runId,
        taskId: '',
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: { lastVerdict: verdictOf(reviewResult), iterations: iteration },
      });
      return {
        runId,
        blocked: true,
        iterations: iteration,
        verdict: verdictOf(reviewResult),
      };
    }

    // integrator step
    await runStepFn(
      runId,
      'integrator',
      'integrator',
      { phase: 'integrate', from: developerResult.output },
      ro,
    );

    return {
      runId,
      blocked: false,
      iterations: iteration,
      verdict: verdictOf(reviewResult),
    };
  };
}

@Injectable()
export class PipelineService {
  /** Registered DBOS-wrapped function types (inferred from registerStep/registerWorkflow). */
  private readonly runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    runnerOverride?: 'script',
  ) => Promise<AttemptResult>;

  private readonly developTaskFn: (
    runId: string,
    opts?: DevelopTaskOpts,
  ) => Promise<DevelopResult>;

  /** The single run-agent used by all steps. claudeCode is a throwing stub (B9). */
  private readonly runAgent: RunAgent;

  constructor(
    private readonly dbos: DbosService,
    private readonly rolesService: RolesService,
    private readonly runService: RunService,
  ) {
    // B9: throwing claudeCode dep — fails fast on non-`--stub` starts with a clear message.
    // 0005 replaces ONLY this dep with createClaudeCodeRunner.
    const throwingClaudeCode: RunAgent = async () => {
      throw new Error(
        "RUNNER_NOT_IMPLEMENTED — slice 0003 is stub-only; use 'run start --stub'",
      );
    };

    this.runAgent = createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent });

    // Capture bound dep methods (S7740: no `this`-aliasing in closures).
    const deps: RunStepDeps = {
      loadRole: this.rolesService.loadRole.bind(this.rolesService),
      loadModelProfile: this.rolesService.loadModelProfile.bind(this.rolesService),
      loadPipelineContext: this.runService.loadPipelineContext.bind(this.runService),
      appendEvent: this.runService.appendEvent.bind(this.runService),
      appendCost: this.runService.appendCost.bind(this.runService),
      runAgent: this.runAgent,
    };

    // Register the step using the production builder (must happen BEFORE DBOS.launch()).
    this.runStepFn = this.dbos.registerStep(
      'PipelineService.runStep',
      makeRunStep(deps),
    );

    // Register the workflow using the production builder with the DBOS-wrapped step.
    this.developTaskFn = this.dbos.registerWorkflow(
      'PipelineService.developTask',
      makeDevelopTask(this.runStepFn, { appendEvent: deps.appendEvent }),
    );

    // Register the WorkflowQueue (idempotent — Map-guarded in DbosService).
    this.dbos.registerQueue(DEV_TASKS_QUEUE, { concurrency: DEV_TASKS_CONCURRENCY });
  }

  /**
   * Enqueue the developTask workflow for the given runId.
   *
   * Idempotent by workflowID=runId: re-starting the same runId returns the existing handle.
   * opts is forwarded as a durable workflow argument (B4/B11) — persisted in the DBOS
   * workflow input row, re-supplied verbatim on crash recovery.
   *
   * B10: `--stub` only takes effect on the FIRST start (idempotent-by-runId);
   * a second `run start --stub` on an already-started run returns the existing handle
   * and does NOT switch the runner (DBOS does not overwrite persisted args).
   * To switch, create a NEW run (new runId) and start THAT with --stub.
   */
  startDevelopTask(
    runId: string,
    opts?: DevelopTaskOpts,
  ): Promise<WorkflowHandle<DevelopResult>> {
    return this.dbos.startWorkflowOn(this.developTaskFn, runId, DEV_TASKS_QUEUE, runId, opts);
  }
}
