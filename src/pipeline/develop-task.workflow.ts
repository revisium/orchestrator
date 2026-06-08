/**
 * PipelineService — the architect→developer→reviewer→integrator DBOS workflow.
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * All DBOS interaction goes through the generic DbosService verbs.
 *
 * Registration happens in the constructor, BEFORE DBOS.launch() (mirroring dev:ping).
 *
 * 0005 changes:
 * - runnerMode (REQUIRED, durable): 'script' | 'live'. Replaces runnerOverride.
 *   Default/missing/invalid → 'script' (fail-safe). --live is the only path to real claude/git/gh.
 * - ClaudeCodeService injected via RUN_AGENT token (replaces throwing stub dep).
 * - IntegratorService injected: runIntegrate (live) + runStub (script) + runPreflight (live).
 * - loadRunTaskContext called once in the workflow body (B6).
 * - Live preflight as a memoized DBOS step (B5/B7): clean + base invariant.
 * - Integrator dispatched on mode: live → integrateFn (DBOS step); script → runStub (pure).
 * - integrate_succeeded event emitted on integrator success (observability MINOR).
 * - Merge gate receives the real prUrl from the integrator result.
 *
 * C1 architecture: the step and workflow bodies are extracted as DBOS-free builder functions
 * (`makeRunStep` / `makeDevelopTask`). PipelineService registers exactly those builders via
 * the engine seam, so tests can import and exercise the SAME production logic directly.
 */
import { Injectable, Inject } from '@nestjs/common';
import type { WorkflowHandle } from '../engine/types.js';
import { DbosService } from '../engine/dbos.service.js';
import { RolesService } from '../revisium/roles.service.js';
import { RunService } from '../revisium/run.service.js';
import { InboxService } from '../revisium/inbox.service.js';
import { IntegratorService, type IntegratorInput, type IntegratorOutput, type IntegratorBlocked } from '../runners/integrator.js';
import { RUN_AGENT } from '../runners/tokens.js';
import { buildContext } from '../worker/build-context.js';
import type { RunAgent, AttemptResult } from '../worker/runner.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { AppendEventInput } from '../run/append-event.js';
import { makeAwaitHuman } from './await-human.js';
import type { Decision } from './await-human.js';
import type { CancelRunResult } from '../run/cancel-run.js';

/** Maximum developer/reviewer rework iterations before failing closed. */
const MAX_REVIEW_ITERATIONS = 3;

/** Queue name for the dev-tasks WorkflowQueue. */
const DEV_TASKS_QUEUE = 'dev-tasks';

/** Concurrency limit for the dev-tasks queue. */
const DEV_TASKS_CONCURRENCY = 2;

/** Durable mode controlling whether real or stub runners + integrator are used. */
export type RunnerMode = 'script' | 'live';

/** Returned by developTask when the pipeline completes, is blocked, or is cancelled by a gate. */
export type DevelopResult = {
  runId: string;
  blocked: boolean;
  iterations: number;
  verdict: string;
  /** true when the plan-gate rejected the run and cancelRun was called (0004 human gate). */
  cancelled: boolean;
};

/** Opts accepted by developTask — slot-1 of the PINNED arity (B11). runnerMode REQUIRED. */
export type DevelopTaskOpts = {
  runnerMode: RunnerMode;
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
  /**
   * Human gate factory result — `await`ed directly in the workflow body at each gate.
   * Wraps pushInbox (deterministic id, ROW_CONFLICT no-op) + DBOS.recv (via awaitDecision).
   * Injected so tests can provide a fake without DBOS (C1 pattern).
   */
  awaitHuman: (
    runId: string,
    topic: 'plan' | 'merge',
    title: string,
    summary: unknown,
  ) => Promise<Decision>;
  /**
   * Cancel a run (patch status + write run_cancelled event). Idempotent (G3).
   * CR-B: accepts optional actor/source to distinguish CLI-cancel from gate-cancel.
   * Injected so tests can assert without a real data-access.
   */
  cancelRun: (runId: string, opts?: { actor?: string; source?: string }) => Promise<CancelRunResult | null>;
  /**
   * Load run task context once in the workflow body (B6).
   * Returns { taskId, title, base, repoRef } from showRun.tasks[0] + run.repos[0].
   */
  loadRunTaskContext: RunService['loadRunTaskContext'];
  /**
   * Real integrator — DBOS step (live only).
   * Execute git/gh ops (branch/commit/push/PR) in the target repo.
   */
  integrateFn: (input: IntegratorInput) => Promise<IntegratorOutput | IntegratorBlocked>;
  /**
   * Stub integrator — pure, zero external effects (script only).
   * Returns { prUrl:'stub://pr/placeholder', branch, prNumber:0 }.
   */
  runStub: (input: IntegratorInput) => IntegratorOutput;
  /**
   * Live preflight — memoized DBOS step (B5/B7, live only).
   * Clean check + base invariant before any claude step runs.
   */
  preflightFn: (taskId: string, base: string) => Promise<{ ok: true } | { needsHuman: true; lesson: string }>;
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
    runnerMode: RunnerMode,
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

    // 6. Apply durable runner mode (M1): live → use role.runner; script → force stub.
    //    Missing/invalid mode coerces to 'script' (NEVER live) — fail-safe.
    const effectiveRunner: typeof loadedRole.runner =
      runnerMode === 'live' ? loadedRole.runner : 'script';
    const dispatchRole = { ...loadedRole, runner: effectiveRunner };

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
    runnerMode: RunnerMode,
  ) => Promise<AttemptResult>,
  deps: DevelopTaskDeps,
) {
  const { appendEvent, awaitHuman, cancelRun, loadRunTaskContext, integrateFn, runStub, preflightFn } = deps;

  return async function developTaskImpl(
    runId: string,
    opts?: DevelopTaskOpts,
  ): Promise<DevelopResult> {
    // Coerce mode: missing/invalid → 'script' (NEVER 'live' — fail-safe, M1).
    const mode: RunnerMode = opts?.runnerMode === 'live' ? 'live' : 'script';

    // B6: resolve task context once at workflow start (deterministic pure read).
    const { taskId, title, base } = await loadRunTaskContext(runId);

    // B5/B7: live preflight — one memoized DBOS step, evaluated exactly once.
    // Skipped entirely on script/stub runs (no git, no cost, no mutation beyond fetch).
    if (mode === 'live') {
      const pf = await preflightFn(taskId, base);
      if ('needsHuman' in pf) {
        await appendEvent({
          runId,
          taskId,
          stepId: '',
          stepKey: 'pipeline',
          type: 'pipeline_blocked',
          payload: { reason: 'preflight', lesson: pf.lesson },
        });
        return { runId, blocked: true, iterations: 0, verdict: 'BLOCKED', cancelled: false };
      }
    }

    // architect step
    const architectResult = await runStepFn(
      runId,
      'architect',
      'architect',
      { phase: 'plan' },
      mode,
    );

    // ── PLAN GATE (after architect, before developer) ──────────────────────────
    const planDecision = await awaitHuman(runId, 'plan', 'Plan approval', architectResult.output);
    if (planDecision.decision === 'reject') {
      await appendEvent({
        runId,
        taskId: '',
        stepId: '',
        stepKey: 'gate:plan',
        type: 'gate_rejected',
        payload: { topic: 'plan' },
      });
      await cancelRun(runId, { actor: 'pipeline', source: 'plan-gate-reject' });
      return { runId, blocked: false, iterations: 0, verdict: 'CANCELLED', cancelled: true };
    }
    // ── end PLAN GATE ──────────────────────────────────────────────────────────

    // developer step (first pass)
    let developerResult = await runStepFn(
      runId,
      'developer',
      'developer',
      { phase: 'implement', from: architectResult.output },
      mode,
    );

    // reviewer step (first pass)
    let reviewResult = await runStepFn(
      runId,
      'reviewer',
      'reviewer',
      { phase: 'review', from: developerResult.output },
      mode,
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
        mode,
      );
      reviewResult = await runStepFn(
        runId,
        'reviewer',
        `reviewer#${iteration}`,
        { phase: 'review', from: developerResult.output },
        mode,
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
        cancelled: false,
      };
    }

    // B3 — mode-gated integrator step (core Round-4 fix).
    // live → DBOS-registered integrateFn (real git/gh, resumable).
    // script → runStub (pure, zero external effects — no git, no gh, no fs).
    const integratorInput: IntegratorInput = { runId, taskId, title, base };
    const integratorResult: IntegratorOutput | IntegratorBlocked =
      mode === 'live'
        ? await integrateFn(integratorInput)
        : runStub(integratorInput);

    // On integrator blocked (live only — nothing to integrate / ambiguous PR / missing remote)
    if ('needsHuman' in integratorResult) {
      await appendEvent({
        runId,
        taskId,
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: { reason: 'integrate', lesson: integratorResult.lesson },
      });
      return { runId, blocked: true, iterations: iteration, verdict: 'BLOCKED', cancelled: false };
    }

    // Observability MINOR: integrate_succeeded event (mirrors step_succeeded at makeRunStep).
    await appendEvent({
      runId,
      taskId,
      stepId: '',
      stepKey: 'integrator',
      type: 'integrate_succeeded',
      payload: {
        prUrl: integratorResult.prUrl,
        branch: integratorResult.branch,
        prNumber: integratorResult.prNumber,
      },
    });

    // ── MERGE GATE (after integrator) ──────────────────────────────────────────
    // Real prUrl from the integrator (live) or 'stub://pr/placeholder' (script).
    const prUrl = integratorResult.prUrl ?? 'stub://pr/placeholder';
    const mergeDecision = await awaitHuman(runId, 'merge', 'Merge approval', { prUrl });
    if (mergeDecision.decision === 'reject') {
      await appendEvent({
        runId,
        taskId: '',
        stepId: '',
        stepKey: 'gate:merge',
        type: 'gate_rejected',
        payload: { topic: 'merge' },
      });
    }
    // ── end MERGE GATE ─────────────────────────────────────────────────────────

    return {
      runId,
      blocked: false,
      iterations: iteration,
      verdict: verdictOf(reviewResult),
      cancelled: false,
    };
  };
}

@Injectable()
export class PipelineService {
  /** Registered DBOS-wrapped function types. */
  private readonly runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    runnerMode: RunnerMode,
  ) => Promise<AttemptResult>;

  private readonly developTaskFn: (
    runId: string,
    opts?: DevelopTaskOpts,
  ) => Promise<DevelopResult>;

  /** The single run-agent used by all steps. */
  private readonly runAgent: RunAgent;

  constructor(
    private readonly dbos: DbosService,
    private readonly rolesService: RolesService,
    private readonly runService: RunService,
    private readonly inboxService: InboxService,
    private readonly integratorService: IntegratorService,
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

    // Register the live preflight as a memoized DBOS step (B5/B7).
    const preflightFn = this.dbos.registerStep(
      'PipelineService.preflightLive',
      this.integratorService.runPreflight.bind(this.integratorService),
    );

    // Build the awaitHuman factory — DBOS-free, depends on injected service verbs.
    const awaitHuman = makeAwaitHuman({
      pushInbox: (item, id) => this.inboxService.pushInbox(item, { id }),
      awaitDecision: (topic) => this.dbos.awaitDecision(topic),
      appendEvent: stepDeps.appendEvent,
    });

    const workflowDeps: DevelopTaskDeps = {
      appendEvent: stepDeps.appendEvent,
      awaitHuman,
      cancelRun: (runId: string, cancelOpts?: { actor?: string; source?: string }) =>
        this.runService.cancelRun(runId, cancelOpts),
      loadRunTaskContext: this.runService.loadRunTaskContext.bind(this.runService),
      integrateFn,
      runStub: this.integratorService.runStub,
      preflightFn,
    };

    // Register the workflow using the production builder with the DBOS-wrapped step.
    this.developTaskFn = this.dbos.registerWorkflow(
      'PipelineService.developTask',
      makeDevelopTask(this.runStepFn, workflowDeps),
    );

    // Register the WorkflowQueue (idempotent — Map-guarded in DbosService).
    this.dbos.registerQueue(DEV_TASKS_QUEUE, { concurrency: DEV_TASKS_CONCURRENCY });
  }

  /**
   * Enqueue the developTask workflow for the given runId.
   *
   * Idempotent by workflowID=runId: re-starting the same runId returns the existing handle.
   * opts.runnerMode is required and forwarded as a durable workflow argument (M1/B11) —
   * persisted in the DBOS workflow input row, re-supplied verbatim on crash recovery.
   *
   * B10: mode only takes effect on the FIRST start (idempotent-by-runId);
   * a second `run start` on an already-started run returns the existing handle
   * and does NOT switch the runner. To switch, create a NEW run.
   */
  startDevelopTask(
    runId: string,
    opts: DevelopTaskOpts,
  ): Promise<WorkflowHandle<DevelopResult>> {
    return this.dbos.startWorkflowOn(this.developTaskFn, runId, DEV_TASKS_QUEUE, runId, opts);
  }
}
