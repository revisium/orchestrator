/**
 * PipelineService — the architect→developer→reviewer→integrator DBOS workflow.
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed).
 * All DBOS interaction goes through the generic DbosService verbs.
 *
 * Registration happens in the constructor, BEFORE DBOS.launch() (mirroring dev:ping).
 *
 * 0005/0009 changes:
 * - Route role bindings are durable and authoritative for runner dispatch.
 *   runnerMode remains only as a private route-less compatibility shim.
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
import type { FailRunResult } from '../run/fail-run.js';
import type { CompleteRunResult } from '../run/complete-run.js';
import {
  dispatchRunnerId,
  type ExecutionProfile,
  type RouteDecision,
  type RouteRoleBinding,
  normalizeRouteGates,
  runnerNeedsLivePreflight,
  runnerUsesRealIntegrator,
} from './route-contract.js';

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

/** Opts accepted by developTask — slot-1 of the PINNED arity (B11). */
export type DevelopTaskOpts = {
  /** Deprecated private shim for legacy tests without a route. Public MCP/CLI uses route role bindings. */
  runnerMode?: RunnerMode;
  route?: RouteDecision;
};

/**
 * verdictOf — extract the reviewer verdict from an AttemptResult.
 *
 * M2 (COMMITTED): fail-closed — missing/unknown verdict returns 'BLOCKER'.
 * Maps the seeded reviewer prompt vocabulary: APPROVE→PASS, REQUEST_CHANGES→MAJOR.
 * Explicit BLOCKER passes through. PASS and MINOR proceed.
 *
 * 0008 dogfood fix: a real claude reviewer emits its verdict as a FREE-TEXT string that BEGINS
 * with the verdict word (e.g. `"APPROVE — all gates pass…"`, `"REQUEST_CHANGES: …"`), not as a
 * structured `{ verdict: … }` object. The original parser only read `output.verdict` and
 * fail-closed every string output to BLOCKER — so genuine APPROVEs looped to the cap and the
 * pipeline never reached the integrator. We now also recognize the leading token of a string
 * output. Fail-closed is preserved: an object with no known verdict, or a string with no
 * recognized LEADING token, still returns BLOCKER (don't integrate ambiguously-reviewed code).
 */
function mapVerdictToken(raw: unknown): string | null {
  switch (raw) {
    case 'PASS':
    case 'APPROVE': // seeded reviewer prompt vocabulary mapping
      return 'PASS';
    case 'MINOR':
      return 'MINOR';
    case 'MAJOR':
    case 'REQUEST_CHANGES': // seeded reviewer prompt vocabulary mapping
      return 'MAJOR';
    case 'BLOCKER':
      return 'BLOCKER';
    default:
      return null; // unrecognized
  }
}

/**
 * Extract a verdict from the LEADING token of a free-text reviewer string.
 * Anchored at the start (after trimming) so a verdict word merely *mentioned* mid-sentence
 * (e.g. "REQUEST_CHANGES — the APPROVE criteria are unmet") resolves by the real leading verdict,
 * not an incidental match. Returns null when the string does not start with a known verdict.
 */
function verdictFromText(text: string): string | null {
  const m = /^(APPROVE|REQUEST_CHANGES|BLOCKER|MAJOR|MINOR|PASS)\b/.exec(text.trimStart().toUpperCase());
  return m ? mapVerdictToken(m[1]) : null;
}

export function verdictOf(result: AttemptResult): string {
  const output = result.output;
  // Structured form: { verdict: "…" }.
  if (output !== null && typeof output === 'object') {
    return mapVerdictToken((output as Record<string, unknown>).verdict) ?? 'BLOCKER';
  }
  // Free-text form: reviewer emitted a string whose leading token is the verdict.
  if (typeof output === 'string') {
    return verdictFromText(output) ?? 'BLOCKER';
  }
  // Missing/non-parseable output → fail-closed.
  return 'BLOCKER';
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
  /** Persist a per-attempt observability row (0008 #4). */
  appendAttempt: RunService['appendAttempt'];
  runAgent: RunAgent;
  /** Monotonic clock for attempt duration (injectable for deterministic tests). Defaults to Date.now. */
  now?: () => number;
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
   * Mark a run failed (patch status → failed + write run_failed event). Idempotent, event-first.
   * Called by the workflow body on a TERMINAL step failure so the Revisium run-row stops lying
   * (DBOS=progress, Revisium=meaning). 0008 #2 — closes the silent-failure gap from the dogfood.
   */
  failRun: (runId: string, reason: string) => Promise<FailRunResult | null>;
  /**
   * Mark a successful workflow terminal in Revisium after the final merge gate resolves.
   * DBOS remains the progress source of truth; this keeps the run-row meaning from staying `ready`.
   */
  completeRun: (
    runId: string,
    opts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
  ) => Promise<CompleteRunResult | null>;
  /**
   * Load run task context once in the workflow body (B6).
   * Returns { taskId, title, base, repoRef } from showRun.tasks[0] + run.repos[0].
   */
  loadRunTaskContext: RunService['loadRunTaskContext'];
  /**
   * Load pipeline limits as DATA (0008 #5) — max review iterations, max attempts, run-level
   * cost/token budget — from the routing_policy table. Falls back to safe defaults when absent.
   */
  loadPipelinePolicy: RolesService['loadPipelinePolicy'];
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
/** Parse the rework iteration from a stepKey (`developer#2` → 2; `developer` → 0). */
function iterationOf(stepKey: string): number {
  const hashIdx = stepKey.lastIndexOf('#');
  if (hashIdx < 0) return 0;
  const n = Number.parseInt(stepKey.slice(hashIdx + 1), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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

    // 7. Run the agent (timed for the attempt-row duration).
    const startedAt = clock();
    const result = await runAgent({ role: dispatchRole, profile, context, attemptId, step });
    const durationMs = Math.max(0, clock() - startedAt);

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
    //     cost records; extract the verdict; redact secrets on store. Idempotent by attemptId.
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
        verdict: verdictOf(result),
        inputTokens,
        outputTokens,
        costAmount,
        durationMs,
        output: result.output,
        lesson: result.lesson,
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
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
  ) => Promise<AttemptResult>,
  deps: DevelopTaskDeps,
) {
  const { appendEvent, awaitHuman, cancelRun, failRun, completeRun, loadRunTaskContext, loadPipelinePolicy, integrateFn, runStub, preflightFn } = deps;

  return async function developTaskImpl(
    runId: string,
    opts?: DevelopTaskOpts,
  ): Promise<DevelopResult> {
    try {
      return await runDevelopTaskBody(runId, opts);
    } catch (err) {
      // TERMINAL step failure (0008 #2): a step threw and propagated to the workflow body. Before
      // re-throwing (so DBOS still records the workflow as ERROR — progress truth is preserved),
      // mark the Revisium run-row `failed` + write a run_failed event so the run-row stops lying.
      // failRun is idempotent (event-first, deterministic id) so DBOS recovery replays are no-ops.
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await failRun(runId, reason);
      } catch (failErr) {
        // Never let bookkeeping mask the original failure — log and re-throw the ORIGINAL error.
        console.error(`[pipeline] failRun(${runId}) itself failed: ${String(failErr)}`);
      }
      throw err;
    }
  };

  async function runDevelopTaskBody(
    runId: string,
    opts?: DevelopTaskOpts,
  ): Promise<DevelopResult> {
    const route = opts?.route ?? legacyRouteDecision(opts?.runnerMode);
    const executionProfile = route.executionProfile;
    const routeGates = normalizeRouteGates(route.routeGates);

    // B6: resolve task context once at workflow start (deterministic pure read).
    const { taskId, title, base } = await loadRunTaskContext(runId);

    // 0008 #5: pipeline limits are DATA (routing_policy), not hardcoded consts. Loaded once.
    const policy = await loadPipelinePolicy();

    // Run-level cost/token BUDGET (0008 #5): accrue each step's cost; a hard-stop blocks the run
    // (pipeline_blocked, reason 'budget') rather than letting an unbounded loop burn the budget.
    let spentUsd = 0;
    let spentTokens = 0;
    let iteration = 0;
    const accrue = (r: AttemptResult): void => {
      for (const c of r.costs) {
        if (!c) continue;
        spentUsd += c.costAmount ?? 0;
        spentTokens += (c.inputTokens ?? 0) + (c.outputTokens ?? 0);
      }
    };
    const overBudget = (): boolean =>
      (policy.budgetUsd > 0 && spentUsd > policy.budgetUsd) ||
      (policy.budgetTokens > 0 && spentTokens > policy.budgetTokens);
    const blockBudget = async (): Promise<DevelopResult> => {
      await appendEvent({
        runId,
        taskId,
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: {
          reason: 'budget',
          spentUsd,
          spentTokens,
          budgetUsd: policy.budgetUsd,
          budgetTokens: policy.budgetTokens,
        },
      });
      return { runId, blocked: true, iterations: iteration, verdict: 'BLOCKED', cancelled: false };
    };
    // runStep — wraps runStepFn to accrue cost so the budget guard sees every step's spend.
    const runStep = async (binding: RouteRoleBinding, stepKey: string, input: unknown): Promise<AttemptResult> => {
      const r = await runStepFn(runId, binding.rowId, stepKey, input, binding.resolvedRunnerId, executionProfile);
      accrue(r);
      return r;
    };
    const runRolePass = async (
      steps: RouteExecutionStep[],
      from: unknown,
      suffix: string,
    ): Promise<{ result: AttemptResult; overBudget: boolean }> => {
      let stepInput = from;
      let lastResult: AttemptResult = { output: { verdict: 'PASS' }, nextSteps: [], costs: [] };
      for (const step of steps) {
        lastResult = await runStep(step.binding, `${step.stepKey}${suffix}`, {
          phase: step.phase,
          from: stepInput,
        });
        stepInput = lastResult.output;
        if (overBudget()) return { result: lastResult, overBudget: true };
      }
      return { result: lastResult, overBudget: false };
    };
    const routePlan = planRouteExecution(route);
    const hasIntegrator = Boolean(routePlan.integrator);
    const executableBindings = [
      ...routePlan.beforeDeveloper,
      routePlan.developer,
      ...routePlan.afterDeveloper,
      routePlan.integrator,
      ...routePlan.postIntegratorStatus,
    ].flatMap((stepOrBinding) => {
      if (!stepOrBinding) return [];
      return 'binding' in stepOrBinding ? [stepOrBinding.binding] : [stepOrBinding];
    });

    // B5/B7: live preflight — one memoized DBOS step, evaluated exactly once.
    // Skipped entirely when every selected binding resolves to a stub/script runner.
    if (executableBindings.some((binding) => runnerNeedsLivePreflight(binding.resolvedRunnerId))) {
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

    let planResult: AttemptResult | null = null;
    for (const step of routePlan.beforeDeveloper) {
      planResult = await runStep(step.binding, step.stepKey, {
        phase: step.phase,
        pipeline: route.pipelineId,
        from: planResult?.output,
      });
      if (overBudget()) return await blockBudget();
    }

    const blockPipeline = async (payload: Record<string, unknown>): Promise<DevelopResult> => {
      await appendEvent({
        runId,
        taskId,
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload,
      });
      return { runId, blocked: true, iterations: iteration, verdict: 'BLOCKED', cancelled: false };
    };

    const plannerOutput = planResult?.output ?? { pipeline: route.pipelineId };
    if (overBudget()) return await blockBudget();

    // ── PLAN GATE (after architect, before developer) ──────────────────────────
    if (routePlan.developer && routeGates.includes('plan')) {
      const planDecision = await awaitHuman(runId, 'plan', 'Plan approval', plannerOutput);
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
    }
    // ── end PLAN GATE ──────────────────────────────────────────────────────────

    if (!routePlan.developer) {
      return await blockPipeline({
        reason: 'route',
        message: `pipeline ${route.pipelineId} has no developer role`,
      });
    }

    // developer step (first pass)
    let developerResult = await runStep(routePlan.developer, routePlan.developer.roleId, {
      phase: 'implement',
      from: plannerOutput,
    });
    if (overBudget()) return await blockBudget();

    // reviewer/watch steps (first pass), preserving route order for every required binding.
    const firstReviewPass = routePlan.afterDeveloper.length > 0
      ? await runRolePass(routePlan.afterDeveloper, developerResult.output, '')
      : { result: { output: { verdict: 'PASS' }, nextSteps: [], costs: [] }, overBudget: false };
    let reviewResult = firstReviewPass.result;
    if (firstReviewPass.overBudget) return await blockBudget();

    // bounded reviewer→developer loop (E5, E6); iteration cap is DATA (0008 #5).
    // Budget is checked after EVERY step so a hard-stop fires before the NEXT agent call burns spend.
    while (isBlocking(verdictOf(reviewResult)) && iteration < policy.maxReviewIterations) {
      iteration++;
      developerResult = await runStep(routePlan.developer, `${routePlan.developer.roleId}#${iteration}`, {
        phase: 'rework',
        feedback: reviewResult.output,
      });
      if (overBudget()) return await blockBudget();
      if (routePlan.afterDeveloper.length === 0) break;
      const reviewPass = await runRolePass(routePlan.afterDeveloper, developerResult.output, `#${iteration}`);
      reviewResult = reviewPass.result;
      if (reviewPass.overBudget) return await blockBudget();
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

    const runIntegration = async (suffix: string): Promise<IntegratorOutput | IntegratorBlocked | null> => {
      if (!hasIntegrator) return null;
      // B3 — binding-gated integrator step.
      // real integrator runner → DBOS-registered integrateFn (real git/gh, resumable).
      // stub/script runner → runStub (pure, zero external effects — no git, no gh, no fs).
      const integratorInput: IntegratorInput = { runId, taskId, title, base };
      const result = runnerUsesRealIntegrator(routePlan.integrator!.resolvedRunnerId)
        ? await integrateFn(integratorInput)
        : runStub(integratorInput);

      if ('needsHuman' in result) return result;

      // Observability MINOR: integrate_succeeded event (mirrors step_succeeded at makeRunStep).
      await appendEvent({
        runId,
        taskId,
        stepId: '',
        stepKey: `integrator${suffix}`,
        type: 'integrate_succeeded',
        payload: {
          prUrl: result.prUrl,
          branch: result.branch,
          prNumber: result.prNumber,
        },
      });
      return result;
    };

    let integratorResult = await runIntegration('');
    if (integratorResult && 'needsHuman' in integratorResult) {
      return await blockPipeline({ reason: 'integrate', lesson: integratorResult.lesson });
    }

    if (integratorResult && routePlan.postIntegratorStatus.length > 0) {
      const firstWatcherPass = await runRolePass(routePlan.postIntegratorStatus, integratorResult, '');
      let watcherResult = firstWatcherPass.result;
      if (firstWatcherPass.overBudget) return await blockBudget();

      let watcherIteration = 0;
      while (isBlocking(verdictOf(watcherResult)) && watcherIteration < policy.maxReviewIterations) {
        watcherIteration++;
        iteration++;
        await runStep(routePlan.developer, `${routePlan.developer.roleId}:watch#${watcherIteration}`, {
          phase: 'watcher-fix',
          feedback: watcherResult.output,
        });
        if (overBudget()) return await blockBudget();

        integratorResult = await runIntegration(`:watch#${watcherIteration}`);
        if (integratorResult && 'needsHuman' in integratorResult) {
          return await blockPipeline({ reason: 'integrate', lesson: integratorResult.lesson });
        }
        const watcherPass = await runRolePass(routePlan.postIntegratorStatus, integratorResult, `#${watcherIteration}`);
        watcherResult = watcherPass.result;
        if (watcherPass.overBudget) return await blockBudget();
      }

      if (isBlocking(verdictOf(watcherResult))) {
        return await blockPipeline({
          reason: 'watcher',
          lastVerdict: verdictOf(watcherResult),
          iterations: watcherIteration,
        });
      }
    }

    // ── MERGE GATE (after integrator) ──────────────────────────────────────────
    // Real prUrl from the integrator (live) or 'stub://pr/placeholder' (script).
    const prUrl = integratorResult?.prUrl ?? 'stub://pr/placeholder';
    const mergeDecision = hasIntegrator && routeGates.includes('merge')
      ? await awaitHuman(runId, 'merge', 'Merge approval', { prUrl })
      : { decision: 'approve' as const };
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

    const finalVerdict = verdictOf(reviewResult);
    await completeRun(runId, {
      actor: 'pipeline',
      source: mergeDecision.decision === 'reject' ? 'merge-gate-reject' : 'merge-gate-approve',
      verdict: finalVerdict,
      iterations: iteration,
    });

    return {
      runId,
      blocked: false,
      iterations: iteration,
      verdict: finalVerdict,
      cancelled: false,
    };
  };

}

type RouteExecutionStep = {
  binding: RouteRoleBinding;
  stepKey: string;
  phase: 'plan' | 'prepare' | 'review' | 'verify' | 'status';
};

type RouteExecutionPlan = {
  beforeDeveloper: RouteExecutionStep[];
  developer?: RouteRoleBinding;
  afterDeveloper: RouteExecutionStep[];
  integrator?: RouteRoleBinding;
  postIntegratorStatus: RouteExecutionStep[];
};

const SUPPORTED_ROUTE_PIPELINES = new Set([
  'legacy-develop-task',
  'local-change',
  'feature-development',
  'bugfix',
  'analysis-only',
]);

function planRouteExecution(route: RouteDecision): RouteExecutionPlan {
  validateRouteBindings(route);
  const executableBindings = route.roleBindings.filter((binding) => !isOrchestrationRole(binding));
  const integratorIndex = singleRoleIndex(route, executableBindings, isIntegratorRole, 'integrator');
  const afterIntegratorBindings = integratorIndex >= 0 ? executableBindings.slice(integratorIndex + 1) : [];
  const postIntegratorStatus = afterIntegratorBindings.filter((binding) => isPostIntegratorStatusRole(binding));
  validatePostIntegratorBindings(route, afterIntegratorBindings);
  const nonIntegratorBindings = integratorIndex >= 0
    ? executableBindings.slice(0, integratorIndex)
    : executableBindings;
  const developerIndex = singleRoleIndex(route, nonIntegratorBindings, isDeveloperRole, 'developer');
  const beforeDeveloperBindings = developerIndex >= 0 ? nonIntegratorBindings.slice(0, developerIndex) : nonIntegratorBindings;
  const afterDeveloperBindings = developerIndex >= 0 ? nonIntegratorBindings.slice(developerIndex + 1) : [];
  const reviewerBindings = beforeDeveloperBindings.filter((binding) => isReviewRole(binding));
  const canonicalFeatureDevelopmentCodeReview = route.pipelineId === 'feature-development' && afterDeveloperBindings.length === 0
    ? reviewerBindings
    : [];
  validateFeatureDevelopmentRoute(route, canonicalFeatureDevelopmentCodeReview, postIntegratorStatus);

  return {
    beforeDeveloper: beforeDeveloperBindings.map((binding, index) => ({
      binding,
      stepKey: binding.roleId,
      phase: beforeDeveloperPhase(binding, index),
    })),
    developer: developerIndex >= 0 ? nonIntegratorBindings[developerIndex] : undefined,
    afterDeveloper: [
      ...afterDeveloperBindings.map((binding) => ({
        binding,
        stepKey: binding.roleId,
        phase: isReviewRole(binding) ? 'review' as const : 'verify' as const,
      })),
      ...canonicalFeatureDevelopmentCodeReview.map((binding) => ({
        binding,
        stepKey: `${binding.roleId}:code`,
        phase: 'review' as const,
      })),
    ],
    integrator: integratorIndex >= 0 ? executableBindings[integratorIndex] : undefined,
    postIntegratorStatus: postIntegratorStatus.map((binding) => ({
      binding,
      stepKey: binding.roleId,
      phase: 'status',
    })),
  };
}

function validateRouteBindings(route: RouteDecision): void {
  if (!SUPPORTED_ROUTE_PIPELINES.has(route.pipelineId)) {
    throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} is not supported by develop-task workflow`);
  }
  if (route.roleBindings.length === 0) {
    throw new Error(`ROUTE_INVALID: pipeline ${route.pipelineId} has no selected roles`);
  }

  const roleIds = new Set<string>();
  for (const binding of route.roleBindings) {
    if (roleIds.has(binding.roleId)) {
      throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} has duplicate role binding: ${binding.roleId}`);
    }
    roleIds.add(binding.roleId);
  }
  for (const requiredRole of route.requiredRoles) {
    if (!roleIds.has(requiredRole)) {
      throw new Error(`ROUTE_INVALID: pipeline ${route.pipelineId} required role is not bound: ${requiredRole}`);
    }
  }
}

function singleRoleIndex(
  route: RouteDecision,
  bindings: RouteRoleBinding[],
  predicate: (binding: RouteRoleBinding) => boolean,
  roleLabel: string,
): number {
  const indexes = bindings
    .map((binding, index) => predicate(binding) ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length > 1) {
    throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} has multiple ${roleLabel} roles`);
  }
  return indexes[0] ?? -1;
}

function validatePostIntegratorBindings(route: RouteDecision, bindings: RouteRoleBinding[]): void {
  const unsupportedAfter = bindings.filter((binding) => !isPostIntegratorStatusRole(binding));
  if (unsupportedAfter.length === 0) return;

  const after = unsupportedAfter.map((binding) => binding.roleId).join(', ');
  throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} has executable roles after integrator: ${after}`);
}

function validateFeatureDevelopmentRoute(
  route: RouteDecision,
  codeReviewBindings: RouteRoleBinding[],
  postIntegratorStatus: RouteRoleBinding[],
): void {
  if (route.pipelineId !== 'feature-development') return;
  if (codeReviewBindings.length === 0) {
    throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} requires a post-developer reviewer`);
  }
  if (postIntegratorStatus.length === 0) {
    throw new Error(`ROUTE_UNSUPPORTED: pipeline ${route.pipelineId} requires a post-integrator watcher`);
  }
}

function beforeDeveloperPhase(binding: RouteRoleBinding, index: number): RouteExecutionStep['phase'] {
  if (index === 0) return 'plan';
  if (isReviewRole(binding)) return 'review';
  return 'prepare';
}

function isDeveloperRole(binding: RouteRoleBinding): boolean {
  return ['developer', 'developer-backend', 'developer-frontend', 'knowledge-engineer'].includes(binding.roleId);
}

function isOrchestrationRole(binding: RouteRoleBinding): boolean {
  return binding.roleId === 'orchestrator';
}

function isReviewRole(binding: RouteRoleBinding): boolean {
  return ['reviewer', 'watcher', 'pr-watcher'].includes(binding.roleId);
}

function isIntegratorRole(binding: RouteRoleBinding): boolean {
  return binding.roleId === 'integrator' || runnerUsesRealIntegrator(binding.resolvedRunnerId);
}

function isPostIntegratorStatusRole(binding: RouteRoleBinding): boolean {
  return binding.roleId === 'watcher' || binding.roleId === 'pr-watcher';
}

function legacyRouteDecision(runnerMode: RunnerMode = 'script'): RouteDecision {
  const claudeRunner = runnerMode === 'live' ? 'live' : 'script';
  const integratorRunner = runnerMode === 'live' ? 'revo-integrator' : 'stub-agent';
  return {
    playbookId: '',
    pipelineId: 'legacy-develop-task',
    pipelineRowId: '',
    source: 'explicit',
    roles: ['architect', 'developer', 'reviewer', 'integrator'],
    requiredRoles: ['architect', 'developer', 'reviewer', 'integrator'],
    optionalRoles: [],
    routeGates: ['plan', 'merge'],
    executionPolicy: {},
    executionProfile: { id: 'legacy', runnerOverrides: {} },
    roleBindings: [
      { roleId: 'architect', rowId: 'architect', modelLevel: 'deep', runnerId: 'claude-code', resolvedRunnerId: claudeRunner, runnerSource: 'playbook' },
      { roleId: 'developer', rowId: 'developer', modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId: claudeRunner, runnerSource: 'playbook' },
      { roleId: 'reviewer', rowId: 'reviewer', modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId: claudeRunner, runnerSource: 'playbook' },
      { roleId: 'integrator', rowId: 'integrator', modelLevel: 'standard', runnerId: 'revo-integrator', resolvedRunnerId: integratorRunner, runnerSource: 'playbook' },
    ],
    params: {},
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
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
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
      failRun: (runId: string, reason: string) => this.runService.failRun(runId, reason),
      completeRun: (
        runId: string,
        completeOpts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
      ) => this.runService.completeRun(runId, completeOpts),
      loadRunTaskContext: this.runService.loadRunTaskContext.bind(this.runService),
      loadPipelinePolicy: this.rolesService.loadPipelinePolicy.bind(this.rolesService),
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
   * Route role bindings are persisted in the DBOS workflow input row and are authoritative for
   * runner dispatch on recovery. opts.runnerMode is a private legacy fallback for route-less tests.
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
