/**
 * data-driven-task.workflow.ts — the DBOS effect-adapter for a DATA-DRIVEN pipeline (plan 0015 §10).
 *
 * Runs the pure `pipeline-core` graph on REAL DBOS, PARALLEL to the hardcoded `develop-task.workflow`.
 * The hardcoded path is untouched; selection routes a pipeline that carries a state-machine template
 * (`specVersion` + `nodes`) here, everything else to `developTask` (see TaskControlPlaneApiService).
 *
 * INVARIANT: `src/pipeline/*` imports NO `@dbos-inc/dbos-sdk` (M1 — DBOS sealed). All DBOS interaction
 * goes through the generic DbosService verbs (registerStep/registerWorkflow/awaitDecision) injected as
 * deps. This file is registered via the engine seam in PipelineService.
 *
 * GENERIC ENGINE: zero role-ids / pipeline shapes here. `roleRef`/`scriptRef` are opaque capability
 * handles resolved against the run's route bindings + the existing runner machinery (§1/§10).
 *
 * The loop (§10):
 *   { state, decision } = core.step(template, state, lastResult)
 *     → execute `decision` as a durable DBOS step (runner / human gate / integrator / fork)
 *     → validate result vs the node's `resultSchema` + redact at this boundary (reuse runStep/append)
 *     → record the result as the next `lastResult`
 *   → repeat until `decision.type === 'complete'` → finish the run.
 *
 * RECOVERY: DBOS replays the workflow body; `core.step` is deterministic and every effect is a durable
 * memoized DBOS step, so a replay re-derives the identical Decision sequence and consumes the recorded
 * step results — no live race, no duplicate effects (deterministic ids + ROW_CONFLICT no-op).
 *
 * C1 architecture: the body is an extracted DBOS-free builder (`makeDataDrivenTask`) registered via the
 * engine seam, so tests exercise the SAME production logic directly with a plain step fn.
 */

import {
  step as coreStep,
  initialState,
  validateTemplate,
  InterpretError,
  type Decision,
  type LastResult,
  type Node,
  type RunState,
  type Template,
  type TerminalStatus,
} from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { ExecutionProfile, RouteDecision, RouteRoleBinding } from './route-contract.js';
import { runnerUsesRealIntegrator } from './route-contract.js';
import type { IntegratorInput, IntegratorOutput, IntegratorBlocked } from '../runners/integrator.js';
import type { AppendEventInput } from '../run/append-event.js';
import type { Decision as GateDecision } from './await-human.js';
import type { CompleteRunResult } from '../run/complete-run.js';
import type { FailRunResult } from '../run/fail-run.js';
import type { BlockRunResult } from '../run/block-run.js';

/** Returned by dataDrivenTask when the pipeline reaches a terminal node. */
export type DataDrivenResult = {
  runId: string;
  /** The terminal status the core's `complete` Decision carried. */
  status: TerminalStatus;
  /** The last DOMAIN verdict observed (for observability/parity with DevelopResult.verdict). */
  verdict: string;
  /** Number of effect (role/script) invocations performed. */
  steps: number;
};

/** Opts passed to dataDrivenTask — the route (capability resolution) + the PINNED template. */
export type DataDrivenTaskOpts = {
  route: RouteDecision;
  /** The pinned, validated state-machine template (a DBOS workflow arg ⇒ durable on recovery). */
  template: Template;
};

const MAX_STEPS = 1_000; // a VALID template terminates; guards a data/loop authoring mistake at runtime.

/** A reserved engine error code (matched only by a node's `catch`, §3/§6). */
const REVO_SCRIPT_FAILED = 'revo.ScriptFailed' as const;
const REVO_RESULT_INVALID = 'revo.ResultInvalid' as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extract the DOMAIN verdict from a recorded agent/script result, restricted to the node's declared
 * `outcomes`/domain vocabulary. The engine treats domain verdicts as opaque labels (§8): we read the
 * agent's free output for a label the template can route on, never inventing engine semantics.
 *
 * Resolution order: explicit `output.verdict` (string) → a leading-token string output → undefined.
 * The value is lowercased to match the spec's domain vocabulary (`approved|blocker|clean|…`).
 */
function domainVerdictOf(result: AttemptResult): string | undefined {
  const output = result.output;
  const raw = isRecord(output) ? output.verdict : output;
  if (typeof raw !== 'string') return undefined;
  return normalizeDomainLabel(raw);
}

/**
 * Normalize an agent's free-text verdict token to a domain label. The seeded test/agent vocabulary
 * uses PASS/BLOCKER/MAJOR/etc.; the data-driven templates use approved/blocker/clean/dirty/… . We map
 * the well-known structural tokens to the closest domain label and otherwise pass the lowercased token
 * through (so a template that declares its own labels just works). Total + deterministic.
 */
function normalizeDomainLabel(raw: string): string {
  const token = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  switch (token) {
    case 'PASS':
    case 'PASSED':
    case 'APPROVE':
    case 'APPROVED':
    case 'CLEAN':
    case 'READY':
    case 'VERIFIED':
      // A passing structural token maps to the canonical "good" labels; the interpreter only routes on
      // labels a guard names, so emitting both-equivalents is unnecessary — return the lowercased token.
      return token === 'CLEAN' ? 'clean' : 'approved';
    case 'MINOR':
      return 'approved'; // MINOR proceeds (parity with the hardcoded isBlocking)
    case 'MAJOR':
    case 'REQUEST_CHANGES':
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'BLOCKER':
    case 'BLOCK':
    case 'DIRTY':
      return token === 'DIRTY' ? 'dirty' : 'blocker';
    default:
      return raw.trim().toLowerCase();
  }
}

/**
 * Validate a recorded result against a node's `resultSchema` at the ADAPTER boundary (§10). MVP
 * contract (resolves §14 Q3 — resultSchema is a DATA handle, validated structurally here): a declared
 * `resultSchema` requires a non-empty object/string output. Token redaction already happens inside
 * `runStep`/`appendEvent`; this guards a malformed effect result → `revo.ResultInvalid` (§6 precedence).
 */
function resultSatisfiesSchema(node: Node, result: AttemptResult): boolean {
  if (!('resultSchema' in node) || !node.resultSchema) return true;
  const output = result.output;
  if (output === null || output === undefined) return false;
  if (typeof output === 'string') return output.length > 0;
  if (isRecord(output)) return true;
  return Array.isArray(output);
}

// ── Dep shapes (C1 — mirrors makeDevelopTask) ─────────────────────────────────

/** Dependencies for the dataDrivenTask builder. */
export type DataDrivenTaskDeps = {
  appendEvent: (input: AppendEventInput) => Promise<void>;
  /** Reuse of the gate park/resume (DBOS recv/send) — the SAME mechanism the hardcoded path uses. */
  awaitHuman: (
    runId: string,
    topic: 'plan' | 'merge',
    title: string,
    summary: unknown,
  ) => Promise<GateDecision>;
  completeRun: (
    runId: string,
    opts?: { actor?: string; source?: string; verdict?: string; iterations?: number },
  ) => Promise<CompleteRunResult | null>;
  failRun: (runId: string, reason: string) => Promise<FailRunResult | null>;
  blockRun: (
    runId: string,
    opts?: { actor?: string; source?: string; reason?: string },
  ) => Promise<BlockRunResult | null>;
  /** Resolve { taskId, title, base } once at workflow start (reused from RunService). */
  loadRunTaskContext: (runId: string) => Promise<{ taskId: string; title: string; base: string; repoRef: string }>;
  /** Real integrator — DBOS step (live). */
  integrateFn: (input: IntegratorInput) => Promise<IntegratorOutput | IntegratorBlocked>;
  /** Stub integrator — pure (script). */
  runStub: (input: IntegratorInput) => IntegratorOutput;
};

/**
 * Map an approve/reject human decision onto a DOMAIN verdict the template's gate `outcomes` can route.
 * The core never sees approve/reject — it routes on a domain label (§8). Approve → the first declared
 * outcome (the "proceed" label by template convention, e.g. `approved`); reject → fail-closed to a
 * NON-first outcome if one exists (e.g. `changes_requested`), else undefined so the gate's `default`
 * (typically a `blocked` terminal) fires. This keeps gate semantics 100% in the routing data (§6/§8).
 */
function gateVerdict(decision: GateDecision, outcomes: string[]): string | undefined {
  if (decision.decision === 'approve') return outcomes[0];
  // reject: prefer a declared "rework/changes" outcome; else let the default branch route (blocked).
  return outcomes.length > 1 ? outcomes.at(-1) : undefined;
}

/** Stable gate topic from a node's reason (plan-review → 'plan', merge-review → 'merge', else 'plan'). */
function gateTopicFor(reason: string): 'plan' | 'merge' {
  return /merge/i.test(reason) ? 'merge' : 'plan';
}

/**
 * makeDataDrivenTask — DBOS-free factory for the dataDrivenTask async function (C1).
 *
 * Receives the (DBOS-wrapped in prod, plain in tests) `runStepFn` so the body is IDENTICAL across
 * production and tests. Returns a plain async function with the workflow signature.
 */
export function makeDataDrivenTask(
  runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
  ) => Promise<AttemptResult>,
  deps: DataDrivenTaskDeps,
) {
  const { appendEvent, awaitHuman, completeRun, failRun, blockRun, loadRunTaskContext, integrateFn, runStub } = deps;

  return async function dataDrivenTaskImpl(
    runId: string,
    opts: DataDrivenTaskOpts,
  ): Promise<DataDrivenResult> {
    try {
      return await runBody(runId, opts);
    } catch (err) {
      // TERMINAL failure: mark the Revisium run-row `failed` (idempotent, event-first) before
      // re-throwing so DBOS still records the workflow ERROR (progress truth) and the run-row stops
      // lying. Mirrors makeDevelopTask's top-level catch (0008 #2).
      const reason = err instanceof Error ? err.message : String(err);
      try {
        await failRun(runId, reason);
      } catch (failErr) {
        console.error(`[data-driven] failRun(${runId}) itself failed: ${String(failErr)}`);
      }
      throw err;
    }
  };

  async function runBody(runId: string, opts: DataDrivenTaskOpts): Promise<DataDrivenResult> {
    const { route, template } = opts;

    // Defense-in-depth: the pinned template is validated at the boundary (§9 — pipeline-core is the
    // authoritative validator even though selection already validated it). A broken pin fails the run.
    const diagnostics = validateTemplate(template).filter((d) => d.severity === 'error');
    if (diagnostics.length > 0) {
      throw new Error(
        `PINNED_TEMPLATE_INVALID: ${template.pipelineId} — ${diagnostics.map((d) => d.code).join(', ')}`,
      );
    }

    const { taskId, title, base } = await loadRunTaskContext(runId);

    // Capability resolution map (GENERIC — no role-ids in the engine): roleRef/scriptRef → route binding.
    // The route's bindings are authoritative for runner dispatch (and durable on recovery via the DBOS
    // workflow input). A `role:<id>` handle resolves to the binding whose roleId matches `<id>`. A
    // `script:<id>` handle likewise resolves by roleId; additionally the canonical `script:integrator`
    // handle resolves to whichever binding's RESOLVED runner mechanically performs the merge (runner-
    // wins, D7) so the integrator script dispatches real-vs-stub exactly like the hardcoded path.
    const bindingByRef = new Map<string, RouteRoleBinding>();
    for (const binding of route.roleBindings) {
      bindingByRef.set(`role:${binding.roleId}`, binding);
      bindingByRef.set(`script:${binding.roleId}`, binding);
      bindingByRef.set(binding.roleId, binding);
      if (runnerUsesRealIntegrator(binding.resolvedRunnerId) && !bindingByRef.has('script:integrator')) {
        bindingByRef.set('script:integrator', binding);
      }
    }
    const executionProfile = route.executionProfile;

    let state: RunState = initialState(template);
    let lastResult: LastResult | undefined;
    let lastVerdict = '';
    let stepCount = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      const { state: nextState, decision } = coreStep(template, state, lastResult);
      state = nextState;

      if (decision.type === 'complete') {
        return await finish(runId, decision.status, lastVerdict, stepCount);
      }

      const eff = await applyDecision(decision, {
        runId, template, bindingByRef, executionProfile, taskId, title, base,
      });
      lastResult = eff.lastResult;
      if (eff.lastVerdict !== undefined) lastVerdict = eff.lastVerdict;
      stepCount += eff.stepDelta;
    }

    throw new InterpretError(
      `data-driven ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (template loop bug)`,
    );
  }

  // ── Decision dispatch ────────────────────────────────────────────────────────

  /** What executing one non-terminal Decision yields back to the loop. */
  type DecisionEffect = { lastResult: LastResult | undefined; lastVerdict?: string; stepDelta: number };
  type EffectCtx = {
    runId: string;
    template: Template;
    bindingByRef: Map<string, RouteRoleBinding>;
    executionProfile: ExecutionProfile;
    taskId: string;
    title: string;
    base: string;
  };

  /**
   * Execute ONE non-terminal Decision as a durable effect and return the next `lastResult`/`lastVerdict`
   * + the step-count delta. Extracted from the `runBody` loop so each is small + independently testable
   * (the loop just threads the result; this is the per-kind dispatch).
   */
  async function applyDecision(
    decision: Exclude<Decision, { type: 'complete' }>,
    ctx: EffectCtx,
  ): Promise<DecisionEffect> {
    const { runId, template, bindingByRef, executionProfile, taskId, title, base } = ctx;
    switch (decision.type) {
      case 'invokeRole': {
        const node = resolveNode(template, decision.nodeId);
        const result = await invokeRole(runId, decision, node, bindingByRef, executionProfile);
        if (result.failed) {
          return { lastResult: { outcome: 'failed', errorCode: result.errorCode }, lastVerdict: 'failed', stepDelta: 1 };
        }
        const verdict = result.verdict;
        return {
          lastResult: { outcome: 'succeeded', ...(verdict ? { verdict } : {}) },
          ...(verdict ? { lastVerdict: verdict } : {}),
          stepDelta: 1,
        };
      }
      case 'invokeScript': {
        const scriptResult = await invokeScript(runId, decision, { taskId, title, base }, bindingByRef);
        if (scriptResult.failed) {
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_FAILED }, lastVerdict: 'failed', stepDelta: 1 };
        }
        return { lastResult: { outcome: 'succeeded' }, stepDelta: 1 };
      }
      case 'awaitGate': {
        const topic = gateTopicFor(decision.reason);
        const human = await awaitHuman(runId, topic, `${decision.reason} approval`, {
          nodeId: decision.nodeId,
          outcomes: decision.outcomes,
        });
        const verdict = gateVerdict(human, decision.outcomes);
        return { lastResult: verdict ? { verdict } : {}, ...(verdict ? { lastVerdict: verdict } : {}), stepDelta: 0 };
      }
      case 'fork': {
        // Fork/join is supported by the core; the MVP feature-development pipeline has none. Record a
        // deterministic barrier arrival per branch (verdict undefined) so an `all` join proceeds. A richer
        // concurrent-branch executor (DBOS child workflows) is a later slice (§14 Q1).
        await appendEvent({
          runId,
          taskId,
          stepId: '',
          stepKey: `fork:${decision.nodeId}`,
          type: 'pipeline_fork',
          payload: { nodeId: decision.nodeId, branches: decision.branches.map((b) => b.id), joinId: decision.joinId },
        });
        return {
          lastResult: { joinArrivals: decision.branches.map((b, idx) => ({ branchId: b.id, seq: idx + 1 })) },
          stepDelta: 0,
        };
      }
      case 'startTimer':
        // `wait` nodes are rare (§1) and unused by the MVP templates; a durable timer executor is a later
        // slice. Treat as an immediate (recorded) resume so a template using it still advances.
        return { lastResult: {}, stepDelta: 0 };
    }
  }

  // ── Effect executors ─────────────────────────────────────────────────────────

  /** invokeRole → dispatch via the existing runStep DBOS step; validate result vs resultSchema. */
  async function invokeRole(
    runId: string,
    decision: Extract<Decision, { type: 'invokeRole' }>,
    node: Node,
    bindingByRef: Map<string, RouteRoleBinding>,
    executionProfile: ExecutionProfile,
  ): Promise<{ failed: true; errorCode: typeof REVO_RESULT_INVALID } | { failed: false; verdict?: string }> {
    const binding = bindingByRef.get(decision.roleRef);
    if (!binding) {
      // A VALID template's caps resolve at run start; an unresolved roleRef is a fatal config gap.
      throw new Error(`CAPABILITY_UNRESOLVED: roleRef ${decision.roleRef} has no route binding`);
    }
    // stepKey carries the nodeId so per-node attempts/events are distinct (and stable across replay).
    const result = await runStepFn(
      runId,
      binding.rowId,
      decision.nodeId,
      { nodeId: decision.nodeId },
      binding.resolvedRunnerId,
      executionProfile,
    );
    // runStep converts a runner-process crash into a blocking attempt (needsHuman + verdict BLOCKER);
    // that is a domain failure of the node → route via §6 precedence as a result-invalid/failed effect.
    if (result.needsHuman || !resultSatisfiesSchema(node, result)) {
      return { failed: true, errorCode: REVO_RESULT_INVALID };
    }
    return { failed: false, verdict: domainVerdictOf(result) };
  }

  /**
   * invokeScript → the built-in system SCRIPT library. The only built-in v1 script is the integrator
   * (`script:integrator`); it dispatches to the real integrator (live) or the stub (script) exactly as
   * the hardcoded path does — runner-wins via the resolved binding (D7). A needsHuman/throw is a
   * `revo.ScriptFailed` (§6 — routed by the node's `catch`).
   */
  async function invokeScript(
    runId: string,
    decision: Extract<Decision, { type: 'invokeScript' }>,
    ctx: { taskId: string; title: string; base: string },
    bindingByRef: Map<string, RouteRoleBinding>,
  ): Promise<{ failed: boolean }> {
    const binding = bindingByRef.get(decision.scriptRef) ?? bindingByRef.get('script:integrator');
    const integratorInput: IntegratorInput = { runId, taskId: ctx.taskId, title: ctx.title, base: ctx.base };
    let result: IntegratorOutput | IntegratorBlocked;
    try {
      // A script node whose resolved runner mechanically performs the merge uses the real integrator;
      // otherwise the pure stub (zero git/gh). Absent a binding (template-only script), default to stub.
      result = binding && runnerUsesRealIntegrator(binding.resolvedRunnerId)
        ? await integrateFn(integratorInput)
        : runStub(integratorInput);
    } catch (err) {
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey: decision.nodeId,
        type: 'step_failed',
        payload: { scriptRef: decision.scriptRef, error: err instanceof Error ? err.message : String(err) },
      });
      return { failed: true };
    }
    if ('needsHuman' in result) {
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey: decision.nodeId,
        type: 'step_failed',
        payload: { scriptRef: decision.scriptRef, lesson: result.lesson },
      });
      return { failed: true };
    }
    await appendEvent({
      runId,
      taskId: ctx.taskId,
      stepId: '',
      stepKey: decision.nodeId,
      type: 'integrate_succeeded',
      payload: { prUrl: result.prUrl, branch: result.branch, prNumber: result.prNumber },
    });
    return { failed: false };
  }

  /** Terminal: finish the run in Revisium per the core's terminal status. */
  async function finish(
    runId: string,
    status: TerminalStatus,
    verdict: string,
    steps: number,
  ): Promise<DataDrivenResult> {
    if (status === 'succeeded') {
      await completeRun(runId, { actor: 'pipeline', source: 'data-driven-complete', verdict, iterations: steps });
    } else if (status === 'blocked') {
      await appendEvent({
        runId,
        taskId: '',
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: { reason: 'route-terminal', lastVerdict: verdict, steps },
      });
      await blockRun(runId, { actor: 'pipeline', source: 'data-driven-blocked', reason: 'route-terminal' });
    } else {
      await failRun(runId, `data-driven pipeline reached a failed terminal (lastVerdict=${verdict})`);
    }
    return { runId, status, verdict, steps };
  }
}

/** Resolve a node id against the template (a VALID template never dangles — guarded defensively). */
function resolveNode(template: Template, nodeId: string): Node {
  const node = template.nodes[nodeId];
  if (!node) throw new InterpretError(`unknown node id "${nodeId}" (invalid template)`);
  return node;
}
