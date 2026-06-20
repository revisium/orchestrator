/**
 * PipelineService — the DBOS registration hub for the data-driven pipeline engine (plan 0015 / ADR-0002).
 *
 * (Renamed from `develop-task.workflow.ts`: the hardcoded `developTask` workflow that file was named for was
 * removed in the plan-0015 cutover, so the old name described code that no longer exists.)
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * All DBOS interaction goes through the generic DbosService verbs.
 *
 * Registration happens in the constructor, BEFORE DBOS.launch() (mirroring dev:ping).
 *
 * The data-driven engine (`makeDataDrivenTask`, executing a `pipeline-core` graph) is the SOLE pipeline engine:
 * selection routes EVERY pipeline to it (TaskControlPlaneApiService.startRun), and a pipeline lacking a valid
 * data-driven template FAILS LOUD there (PIPELINE_NOT_DATA_DRIVEN). The former hardcoded role→phase classifiers
 * (`planRouteExecution`, `validatePostIntegratorBindings`, …) were removed in that cutover.
 *
 * KEPT here (the shared seams the data-driven adapter reuses):
 *  - `makeRunStep` — the generic per-step runner (role→runner dispatch, attempt/cost/event bookkeeping).
 *  - the run lifecycle verbs (complete/fail/block) + `awaitHuman` (gate park/resume) + the integrator
 *    (real + stub) + the live preflight, wired as DataDrivenTaskDeps.
 *
 * C1 architecture: the step and workflow bodies are extracted as DBOS-free builder functions
 * (`makeRunStep` / `makeDataDrivenTask`). PipelineService registers exactly those builders via
 * the engine seam, so tests can import and exercise the SAME production logic directly.
 */
import { Injectable, Inject } from '@nestjs/common';
import type { WorkflowHandle } from '../engine/types.js';
import { DbosService } from '../engine/dbos.service.js';
import { RolesService } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import { InboxService } from '../revisium/inbox.service.js';
import { IntegratorService } from '../runners/integrator.js';
import { WorktreeService } from '../runners/worktree.service.js';
import { redactTokens } from '../runners/gh-identity.js';
import { RUN_AGENT } from '../runners/tokens.js';
import { buildContext } from '../worker/build-context.js';
import type { RunAgent, AttemptResult } from '../worker/runner.js';
import { artifactsFromRunAgentError } from '../worker/runner.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { AppendEventInput } from '../run/append-event.js';
import { makeAwaitHuman } from './await-human.js';
import {
  makeDataDrivenTask,
  RUN_PROGRESS_EVENT_KEY,
  type DataDrivenResult,
  type DataDrivenTaskDeps,
  type DataDrivenTaskOpts,
} from './data-driven-task.workflow.js';
import {
  dispatchRunnerId,
  type ExecutionProfile,
} from './route-contract.js';

/** Queue name for the dev-tasks WorkflowQueue. */
const DEV_TASKS_QUEUE = 'dev-tasks';

/**
 * Concurrency limit for the dev-tasks queue. Default 2; overridable via `REVO_DEV_TASKS_CONCURRENCY`
 * (a deployment throughput knob, and what lets the e2e crash-recovery suite hold several PENDING
 * runs at once — each parked run occupies a slot until recovered).
 */
const DEV_TASKS_CONCURRENCY = ((): number => {
  const raw = Number.parseInt(process.env['REVO_DEV_TASKS_CONCURRENCY'] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
})();

const RUNNER_FAILURE_REASON_MAX = 2_000;

/**
 * Durable mode controlling whether real or stub runners + integrator are used.
 *
 * Retained as a harmless public type on the API surface (TaskControlPlaneApiService.startRun still
 * accepts an optional `runnerMode` for route-less compatibility callers); the data-driven engine
 * resolves runner dispatch from the route's role bindings, so the value is a no-op for selection.
 */
export type RunnerMode = 'script' | 'live';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ── Dep shapes (C1 — used by makeRunStep builder) ─────────────────────────────

/** Dependencies for the runStep builder. */
export type RunStepDeps = {
  loadRole: RolesService['loadRole'];
  loadModelProfile: RolesService['loadModelProfile'];
  loadPipelineContext: RunService['loadPipelineContext'];
  appendEvent: (input: AppendEventInput) => Promise<void>;
  appendCost: RunService['appendCost'];
  /** Persist a per-attempt observability row (0008 #4). */
  appendAttempt: RunService['appendAttempt'];
  runAgent: RunAgent;
  /** Monotonic clock for attempt duration (injectable for deterministic tests). Defaults to Date.now. */
  now?: () => number;
};

/**
 * verdictForAttemptRow — best-effort verdict label for the observability attempts row.
 *
 * The data-driven engine routes on a node's DOMAIN verdict (resolved in the adapter, §8) and never
 * consults this. This is purely the human-readable verdict surfaced on the per-attempt log row: read
 * an explicit `output.verdict` (string) or the leading token of a free-text string output, else mark
 * it `unknown`. No engine semantics are derived from it.
 */
function verdictForAttemptRow(result: AttemptResult): string {
  const output = result.output;
  if (isRecord(output) && typeof output.verdict === 'string') return output.verdict;
  if (typeof output === 'string') {
    const token = output.trim().split(/\s+/)[0];
    if (token) return token.toUpperCase();
  }
  return 'unknown';
}

/** Parse the rework iteration from a stepKey (`developer#2` → 2; `developer` → 0). */
function iterationOf(stepKey: string): number {
  const hashIdx = stepKey.lastIndexOf('#');
  if (hashIdx < 0) return 0;
  const n = Number.parseInt(stepKey.slice(hashIdx + 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function runnerFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactTokens(message).slice(0, RUNNER_FAILURE_REASON_MAX);
}

function processArtifactFields(artifacts: unknown): { artifactRef?: string; stdoutTail?: string; stderrTail?: string } {
  const processArtifact = isRecord(artifacts) && isRecord(artifacts.process) ? artifacts.process : artifacts;
  if (!isRecord(processArtifact)) return {};
  const ref = processArtifact.ref;
  const stdoutTail = processArtifact.stdoutTail;
  const stderrTail = processArtifact.stderrTail;
  return {
    artifactRef: typeof ref === 'string' ? ref : undefined,
    stdoutTail: typeof stdoutTail === 'string' ? stdoutTail : undefined,
    stderrTail: typeof stderrTail === 'string' ? stderrTail : undefined,
  };
}

/**
 * makeRunStep — DBOS-free factory for the runStep async function.
 *
 * Returns a plain async function with the same signature as the DBOS step.
 * PipelineService passes this to `dbos.registerStep(...)` so tests can import
 * and call it directly — exercising the SAME code path as production (C1).
 */
export function makeRunStep(deps: RunStepDeps) {
  const { loadRole, loadModelProfile, loadPipelineContext, appendEvent, appendCost, appendAttempt, runAgent } = deps;
  const clock = deps.now ?? (() => Date.now());

  return async function runStepImpl(
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
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

    // 6. Dispatch through the resolved per-role runner binding. Legacy direct callers may still
    //    pass runnerMode ('script'|'live') without a route; that fallback is intentionally private.
    const effectiveRunner = dispatchRunnerId(resolveStepRunner(loadedRole.runner, resolvedRunnerId, executionProfile));
    const dispatchRole = { ...loadedRole, runner: effectiveRunner };

    // 7. Run the agent (timed for the attempt-row duration). Runner-process failures are domain
    // failures, not DBOS step failures: convert them to a blocking attempt so the workflow can
    // park/fail the run row instead of leaving DBOS=ERROR with task_runs.status='ready'.
    const startedAt = clock();
    let result: AttemptResult;
    try {
      result = await runAgent({ role: dispatchRole, profile, context, attemptId, step });
    } catch (err) {
      const durationMs = Math.max(0, clock() - startedAt);
      const reason = runnerFailureReason(err);
      const artifactFields = processArtifactFields(artifactsFromRunAgentError(err));
      const output = {
        verdict: 'BLOCKER',
        error: 'runner_failed',
        role,
        stepKey,
        reason,
      };
      await appendEvent({
        runId,
        taskId: step.taskId,
        stepId: step.id,
        stepKey,
        type: 'step_failed',
        payload: { output, role, stepKey, attemptId },
      });
      try {
        await appendAttempt({
          runId,
          stepId: step.id,
          attemptId,
          attemptNo: iterationOf(stepKey) + 1,
          iteration: iterationOf(stepKey),
          status: 'failed',
          modelProfile: step.modelProfile,
          verdict: 'BLOCKER',
          inputTokens: 0,
          outputTokens: 0,
          costAmount: 0,
          durationMs,
          output,
          lesson: reason,
          error: reason,
          ...artifactFields,
        });
      } catch (attemptErr) {
        console.warn(
          `[pipeline] failed-attempt row write failed for ${stepKey} (${attemptId}) — observability only. ` +
            `${String(attemptErr)}`,
        );
      }
      return { output, nextSteps: [], costs: [], needsHuman: true, lesson: reason };
    }
    const durationMs = Math.max(0, clock() - startedAt);
    const artifactFields = processArtifactFields(result.artifacts);

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

    // 10. Persist the per-attempt observability row (0008 #4). Aggregate tokens/cost from the
    //     cost records; surface the verdict; redact secrets on store. Idempotent by attemptId.
    //     NON-FATAL: the attempts row is pure observability — a write failure (e.g. a control-plane
    //     whose attempts schema predates 0008's fields, additionalProperties:false → VALIDATION_FAILURE)
    //     must NEVER fail an otherwise-successful agent step. Log and continue.
    const inputTokens = result.costs.reduce((sum, c) => sum + (c?.inputTokens ?? 0), 0);
    const outputTokens = result.costs.reduce((sum, c) => sum + (c?.outputTokens ?? 0), 0);
    const costAmount = result.costs.reduce((sum, c) => sum + (c?.costAmount ?? 0), 0);
    try {
      await appendAttempt({
        runId,
        stepId: step.id,
        attemptId,
        attemptNo: iterationOf(stepKey) + 1,
        iteration: iterationOf(stepKey),
        status: result.needsHuman ? 'awaiting_approval' : 'succeeded',
        modelProfile: step.modelProfile,
        verdict: verdictForAttemptRow(result),
        inputTokens,
        outputTokens,
        costAmount,
        durationMs,
        output: result.output,
        lesson: result.lesson,
        ...artifactFields,
      });
    } catch (err) {
      console.warn(
        `[pipeline] attempt-row write failed for ${stepKey} (${attemptId}) — observability only, step still succeeds. ` +
          `If this is a schema-drift error, migrate the control-plane attempts table to the 0008 fields. ${String(err)}`,
      );
    }

    return result;
  };
}

function resolveStepRunner(
  roleRunner: string,
  resolvedRunnerId?: string,
  executionProfile?: ExecutionProfile,
): string {
  if (resolvedRunnerId && resolvedRunnerId !== 'live') return resolvedRunnerId;
  if (resolvedRunnerId === 'script') return 'script';
  const profileResolved = executionProfile?.runnerOverrides[roleRunner];
  return profileResolved || roleRunner;
}

@Injectable()
export class PipelineService {
  /** Registered DBOS-wrapped function types. */
  private readonly runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
  ) => Promise<AttemptResult>;

  /**
   * The DATA-DRIVEN workflow (plan 0015) — the SOLE pipeline engine. Selection routes EVERY pipeline
   * here (TaskControlPlaneApiService); the engine executes the pinned `pipeline-core` graph on real
   * DBOS, reusing the SAME runStep DBOS step + awaitHuman + integrator + live preflight.
   */
  private readonly dataDrivenTaskFn: (
    runId: string,
    opts: DataDrivenTaskOpts,
  ) => Promise<DataDrivenResult>;

  /** The single run-agent used by all steps. */
  private readonly runAgent: RunAgent;

  constructor(
    @Inject(DbosService)
    private readonly dbos: DbosService,
    @Inject(RolesService)
    private readonly rolesService: RolesService,
    @Inject(RunService)
    private readonly runService: RunService,
    @Inject(InboxService)
    private readonly inboxService: InboxService,
    @Inject(IntegratorService)
    private readonly integratorService: IntegratorService,
    @Inject(WorktreeService)
    private readonly worktreeService: WorktreeService,
    @Inject(RUN_AGENT) runAgentToken: RunAgent,
  ) {
    this.runAgent = runAgentToken;

    // Capture bound dep methods (S7740: no `this`-aliasing in closures).
    const stepDeps: RunStepDeps = {
      loadRole: this.rolesService.loadRole.bind(this.rolesService),
      loadModelProfile: this.rolesService.loadModelProfile.bind(this.rolesService),
      loadPipelineContext: this.runService.loadPipelineContext.bind(this.runService),
      appendEvent: this.runService.appendEvent.bind(this.runService),
      appendCost: this.runService.appendCost.bind(this.runService),
      appendAttempt: this.runService.appendAttempt.bind(this.runService),
      runAgent: this.runAgent,
    };

    // Register the step using the production builder (must happen BEFORE DBOS.launch()).
    this.runStepFn = this.dbos.registerStep(
      'PipelineService.runStep',
      makeRunStep(stepDeps),
    );

    // Register the REAL integrator as a DBOS step (M6/B7: .bind so `this` survives registration).
    const integrateFn = this.dbos.registerStep(
      'PipelineService.integrate',
      this.integratorService.runIntegrate.bind(this.integratorService),
    );

    // Register the REAL confirm-merge as a DBOS step (plan 0017 follow-up: gate worktree cleanup on a
    // real merge). Idempotent (re-views before merging) → replay-safe.
    const confirmMergeFn = this.dbos.registerStep(
      'PipelineService.confirmMerge',
      this.integratorService.runConfirmMerge.bind(this.integratorService),
    );

    // Register the REAL pollPr + respondThreads as DBOS steps (plan 0018: the PR review-feedback loop).
    // pollPr observes + classifies; respondThreads replies + resolves. Both gh-pinned + idempotent.
    const pollPrFn = this.dbos.registerStep(
      'PipelineService.pollPr',
      this.integratorService.runPollPr.bind(this.integratorService),
    );
    const respondThreadsFn = this.dbos.registerStep(
      'PipelineService.respondThreads',
      this.integratorService.runRespondThreads.bind(this.integratorService),
    );

    // Register the live preflight as a memoized DBOS step (B5/B7).
    const preflightFn = this.dbos.registerStep(
      'PipelineService.preflightLive',
      this.integratorService.runPreflight.bind(this.integratorService),
    );

    // Register the per-run worktree lifecycle as memoized DBOS steps (plan 0017). `ensure` is
    // create-if-absent (idempotent on replay); `release` is best-effort + idempotent.
    const createWorktreeFn = this.dbos.registerStep(
      'PipelineService.worktreeCreate',
      this.worktreeService.ensure,
    );
    const releaseWorktreeFn = this.dbos.registerStep(
      'PipelineService.worktreeRelease',
      this.worktreeService.release,
    );

    // Build the awaitHuman factory — DBOS-free, depends on injected service verbs.
    const awaitHuman = makeAwaitHuman({
      pushInbox: (item, id) => this.inboxService.pushInbox(item, { id }),
      awaitDecision: (topic) => this.dbos.awaitDecision(topic),
      appendEvent: stepDeps.appendEvent,
    });

    // Register the DATA-DRIVEN workflow (plan 0015) using the production builder with the DBOS-wrapped
    // step. Reuses the SAME runStep + awaitHuman + integrator + preflight so capabilities resolve
    // through the existing runner machinery (no duplicate dispatch logic, no role-ids in the engine).
    const dataDrivenDeps: DataDrivenTaskDeps = {
      appendEvent: stepDeps.appendEvent,
      appendRunOutput: this.runService.appendRunOutput.bind(this.runService),
      setProgress: (_runId, cursor) => this.dbos.setEvent(RUN_PROGRESS_EVENT_KEY, cursor),
      awaitHuman,
      completeRun: (
        runId: string,
        completeOpts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
      ) => this.runService.completeRun(runId, completeOpts),
      failRun: (runId: string, reason: string) => this.runService.failRun(runId, reason),
      blockRun: (
        runId: string,
        blockOpts?: { actor?: string; source?: string; reason?: string },
      ) => this.runService.blockRun(runId, blockOpts),
      loadRunTaskContext: this.runService.loadRunTaskContext.bind(this.runService),
      integrateFn,
      runStub: this.integratorService.runStub,
      confirmMergeFn,
      runConfirmStub: this.integratorService.runConfirmStub,
      pollPrFn,
      runPollStub: this.integratorService.runPollStub,
      respondThreadsFn,
      runRespondStub: this.integratorService.runRespondStub,
      preflightFn,
      createWorktreeFn,
      releaseWorktreeFn,
    };
    this.dataDrivenTaskFn = this.dbos.registerWorkflow(
      'PipelineService.dataDrivenTask',
      makeDataDrivenTask(this.runStepFn, dataDrivenDeps),
    );

    // Register the WorkflowQueue (idempotent — Map-guarded in DbosService).
    this.dbos.registerQueue(DEV_TASKS_QUEUE, { concurrency: DEV_TASKS_CONCURRENCY });
  }

  /**
   * Enqueue the DATA-DRIVEN workflow for the given runId (plan 0015).
   *
   * Idempotent by workflowID=runId: re-starting the same runId returns the existing handle. The pinned,
   * validated template is passed as a DBOS workflow ARGUMENT, so it is durable and replayed verbatim on
   * recovery (the MVP pin — a Revisium-revision pin is a later upgrade per §11/§14 Q4). Route role
   * bindings are persisted in the DBOS workflow input row and are authoritative for runner dispatch.
   */
  startDataDrivenTask(
    runId: string,
    opts: DataDrivenTaskOpts,
  ): Promise<WorkflowHandle<DataDrivenResult>> {
    return this.dbos.startWorkflowOn(this.dataDrivenTaskFn, runId, DEV_TASKS_QUEUE, runId, opts);
  }
}
