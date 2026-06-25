/**
 * data-driven-task.workflow.ts — the DBOS effect-adapter for a DATA-DRIVEN pipeline (plan 0015 §10).
 *
 * Runs the pure `pipeline-core` graph on REAL DBOS. As of slice 3 this is the SOLE pipeline engine:
 * selection routes EVERY pipeline here (TaskControlPlaneApiService), executing the state-machine
 * template pinned for the run; a pipeline without a valid template FAILS LOUD at selection. The old
 * hardcoded `developTask` workflow + its role→phase classifiers were removed.
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
import { runnerNeedsLivePreflight, runnerUsesRealIntegrator } from './route-contract.js';
import type { IntegratorInput, IntegratorOutput, IntegratorBlocked, ConfirmMergeOutput, PrFeedback, RespondThreadsOutput } from '../runners/integrator.js';
import type { AppendEventInput } from '../run/append-event.js';
import { redactEventPayload } from '../run/append-event.js';
import { redactSecrets } from '../control-plane/inbox.js';
import type { RunOutputRow } from '../run/run-outputs.js';
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

export const RUN_PROGRESS_EVENT_KEY = 'run-progress';

export type DataDrivenProgressCursor = {
  activeNodeIds: string[];
  scopedCounters: Record<string, number>;
  status: RunState['status'];
  lastResult?: LastResult;
};

/** Opts passed to dataDrivenTask — the route (capability resolution) + the PINNED template. */
export type DataDrivenTaskOpts = {
  route: RouteDecision;
  /** The pinned, validated state-machine template (a DBOS workflow arg ⇒ durable on recovery). */
  template: Template;
};

const MAX_STEPS = 1_000; // a VALID template terminates; guards a data/loop authoring mistake at runtime.

/**
 * Reserved engine error codes (matched only by a node's `catch`, §3/§6).
 *
 * A built-in script (the integrator) has TWO distinct failure modes the routing data discriminates:
 *  - `revo.ScriptBlocked` — the script needs a human (nothing-to-integrate, ambiguous PRs, a refused
 *    pinned identity, a non-JSON `pr view`). NOT a crash; a `catch` routes it to a `blocked` terminal,
 *    and the adapter surfaces the human-readable lesson on a `pipeline_blocked` event (parity with the
 *    old engine's `blockPipeline({ reason:'integrate' })`).
 *  - `revo.ScriptFailed` — the script THREW (a gh/push error). A `catch` routes it to a `failed`
 *    terminal (parity with the old engine's top-level catch → failRun).
 */
const REVO_SCRIPT_FAILED = 'revo.ScriptFailed' as const;
const REVO_SCRIPT_BLOCKED = 'revo.ScriptBlocked' as const;
const REVO_RESULT_INVALID = 'revo.ResultInvalid' as const;
const REVO_INPUT_MISSING = 'revo.InputMissing' as const;

/** Per-node execution stepKey: the bare nodeId on the first entry (stable ids for existing tests), an
 *  ordinal-suffixed key on loop re-entries so attempts/events/outputs are distinct per iteration (0016
 *  §4.1 — fixes the latent 0015 stepKey-reuse collision). */
function stepKeyFor(nodeId: string, ordinal: number): string {
  return ordinal <= 1 ? nodeId : `${nodeId}#${ordinal}`;
}

/** Next per-(run,node) execution ordinal (1-based). Deterministic on DBOS replay: the runBody loop
 *  re-runs identically (coreStep is pure, effects are memoized), so the accumulator is rebuilt 1:1. */
function nextOrdinal(byNode: Map<string, number>, nodeId: string): number {
  const n = (byNode.get(nodeId) ?? 0) + 1;
  byNode.set(nodeId, n);
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Discriminate a TRANSIENT runner failure from a DELIBERATE agent `needsHuman` (both arrive as
 * AttemptResult.needsHuman, but route to DIFFERENT pipeline_blocked lessons — see invokeRole).
 *
 * runStep (pipeline.service.ts §7) converts a runner-process crash / non-zero exit / 429 / timeout into
 * a SYNTHETIC blocking attempt whose `output` is `{ verdict:'BLOCKER', error:'runner_failed', reason }`.
 * That `error:'runner_failed'` marker is set ONLY on that transient path; a deliberate agent's `output`
 * is its own free-form result and never carries it. Returns the recoverable `reason` (possibly empty)
 * when transient, or `undefined` for a deliberate human-block.
 */
function transientRunnerFailureReason(result: AttemptResult): string | undefined {
  const output = result.output;
  if (!isRecord(output) || output.error !== 'runner_failed') return undefined;
  return typeof output.reason === 'string' ? output.reason : '';
}

/** Extract the DOMAIN verdict from the only supported source: top-level AttemptResult.verdict. */
function domainVerdictOf(result: AttemptResult): string | undefined {
  if (typeof result.verdict === 'string' && result.verdict.trim().length > 0) {
    return result.verdict.trim().toLowerCase();
  }
  return undefined;
}

function resultVerdictProblem(template: Template, node: Node, result: AttemptResult): string | undefined {
  if (node.kind !== 'agent') return undefined;
  const verdict = domainVerdictOf(result);
  if (!verdict) {
    return `${REVO_RESULT_INVALID}: node ${node.id} requires top-level result.verdict`;
  }
  if (!template.verdicts.domain.includes(verdict)) {
    return `${REVO_RESULT_INVALID}: node ${node.id} emitted verdict "${verdict}" outside template verdicts.domain [${template.verdicts.domain.join(', ')}]`;
  }
  return undefined;
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

// ── Dep shapes (C1 — the run-lifecycle + effect verbs the adapter calls) ──────

/** Dependencies for the dataDrivenTask builder. */
export type DataDrivenTaskDeps = {
  appendEvent: (input: AppendEventInput) => Promise<void>;
  /** Persist a produced step output to Revisium (0016). DBOS-wrapped in prod; idempotent on replay. */
  appendRunOutput: (input: RunOutputRow) => Promise<void>;
  /** Public DBOS event seam for the latest graph cursor; never writes Revisium progress rows. */
  setProgress?: (runId: string, cursor: DataDrivenProgressCursor) => Promise<void>;
  /** Reuse of the gate park/resume (DBOS recv/send) — the SAME mechanism the hardcoded path uses. */
  awaitHuman: (
    runId: string,
    topic: 'plan' | 'merge' | 'question',
    gateKey: string,
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
  /** Real confirm-merge — DBOS step (live): ensures the PR is merged before the success terminal. */
  confirmMergeFn: (input: IntegratorInput) => Promise<ConfirmMergeOutput | IntegratorBlocked>;
  /** Stub confirm-merge — pure (script). */
  runConfirmStub: (input: IntegratorInput) => ConfirmMergeOutput;
  /** Real pollPr — DBOS step (live): observe + classify PR feedback (plan 0018). Produces prFeedback. */
  pollPrFn: (input: IntegratorInput) => Promise<PrFeedback | IntegratorBlocked>;
  /** Stub pollPr — pure (script): reports a clean PR so the loop converges to the merge gate. */
  runPollStub: (input: IntegratorInput) => PrFeedback;
  /** Real respondThreads — DBOS step (live): reply + resolve the triaged threads (plan 0018). */
  respondThreadsFn: (input: IntegratorInput) => Promise<RespondThreadsOutput | IntegratorBlocked>;
  /** Stub respondThreads — pure (script): no threads to reply/resolve. */
  runRespondStub: (input: IntegratorInput) => RespondThreadsOutput;
  /**
   * Live preflight — memoized DBOS step (B5/B7). Clean check + base invariant, evaluated ONCE before
   * any live runner/integrator effect. Skipped entirely when no binding resolves to a live runner
   * (the same gate the old engine used). A `needsHuman` result blocks the run (pipeline_blocked).
   */
  preflightFn: (taskId: string, base: string) => Promise<{ ok: true } | { needsHuman: true; lesson: string }>;
  /**
   * Per-run worktree lifecycle (plan 0017) — memoized DBOS steps. `createWorktreeFn` is create-if-absent
   * (idempotent on replay), called ONCE after a passing live preflight and before any live effect.
   * `releaseWorktreeFn` is best-effort + idempotent, called from the workflow `finally` at every terminal
   * (succeeded/failed/blocked) — never while parked at a gate (the workflow stays alive across `recv`).
   * Both are no-ops for non-live runs (no worktree is created for stub/script).
   */
  createWorktreeFn: (runId: string, taskId: string, title: string, base: string) => Promise<{ worktreePath: string }>;
  releaseWorktreeFn: (runId: string, taskId: string) => Promise<void>;
};

function progressCursor(state: RunState, lastResult: LastResult | undefined): DataDrivenProgressCursor {
  return {
    activeNodeIds: [...state.activeNodeIds],
    scopedCounters: { ...state.scopedCounters },
    status: state.status,
    ...(lastResult ? { lastResult } : {}),
  };
}

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

/**
 * Stable gate topic from a node's reason. The topic is the DBOS recv channel AND part of the gate
 * inbox id (`runId|topic`), so DISTINCT gates in one pipeline MUST map to DISTINCT topics — otherwise
 * a second gate's `recv` collides with the first's already-consumed message and the run hangs (plan
 * 0018: the `review-question` gate would otherwise reuse the `plan` topic of the plan gate).
 *   merge-review   → 'merge'
 *   review-question→ 'question'
 *   (anything else)→ 'plan'  (the plan-review gate)
 */
function gateTopicFor(reason: string): 'plan' | 'merge' | 'question' {
  if (/merge/i.test(reason)) return 'merge';
  if (/question/i.test(reason)) return 'question';
  return 'plan';
}

// D3 — enrich the gate inbox row with the artifact under review + the reviewer verdict, inline, so an
// approver decides without digging the agent log. `pushInbox` has no size cap (unlike run-outputs'
// PAYLOAD_MAX), so the artifact is budgeted HERE: over-budget → a head preview + a payload_ref locator,
// never the full payload. The inbox id is keyed by runId|gateKey only, so a larger context does not
// change it → pushInbox stays idempotent on replay. The payload is also secret/token redacted at this
// build site (pushInbox only masks secret-NAMED keys, not token SHAPES in free-text) — see gateArtifactView.
export const GATE_ARTIFACT_MAX = 16_000;
export const GATE_PREVIEW_CHARS = 4_000;

export type GateArtifactView = {
  nodeId: string;
  name: string;
  schemaRef: string;
  payload?: unknown;
  truncated?: true;
  preview?: string;
  payloadRef?: string;
};
export type GateSummary = {
  nodeId: string;
  outcomes: string[];
  gatedArtifact?: GateArtifactView;
  reviewerVerdict?: GateArtifactView | { verdict: string };
};

/** Latest (or pinned-ordinal) output row for a gate ref, or undefined if the producer has not run. */
function resolveGateRow(
  ref: { node: string; iteration?: 'latest' | 'all' | number } | undefined,
  outputsByNode: Map<string, RunOutputRow[]>,
): RunOutputRow | undefined {
  if (!ref) return undefined;
  const produced = outputsByNode.get(ref.node) ?? [];
  if (produced.length === 0) return undefined;
  if (typeof ref.iteration === 'number') return produced.find((o) => o.ordinal === ref.iteration);
  return produced[produced.length - 1]; // 'latest' (and 'all' → the most recent for an inline view)
}

/**
 * Inline artifact view with the 16KB budget. Secrets + token shapes are scrubbed BEFORE inlining or
 * previewing — mirroring run-outputs.ts (the sibling persist boundary): pushInbox only masks
 * secret-NAMED keys, so a token shape (`ghp_…`) in a free-text field (e.g. pollPr's prFeedback) would
 * otherwise persist verbatim. Over-budget → a head preview (of the redacted serialization) + an
 * `attempt:` locator (the full artifact is recoverable from that attempt's agent log).
 */
function gateArtifactView(row: RunOutputRow, as?: string): GateArtifactView {
  const base = { nodeId: row.nodeId, name: as ?? row.name, schemaRef: row.schemaRef };
  const safe = redactEventPayload(redactSecrets(row.payload) ?? null);
  const serialized = JSON.stringify(safe ?? null);
  // Budget on BYTES (not UTF-16 length) so a multi-byte payload can't slip past the cap.
  if (Buffer.byteLength(serialized, 'utf8') <= GATE_ARTIFACT_MAX) return { ...base, payload: safe };
  return {
    ...base,
    truncated: true,
    preview: serialized.slice(0, GATE_PREVIEW_CHARS),
    payloadRef: `attempt:${row.attemptId ?? ''}`,
  };
}

/**
 * Build the enriched gate inbox summary from the workflow-local outputs (replay-safe — rebuilt
 * identically, 0016 §6). `verdictFrom` resolves a node's verdict output; when it is NOT specified, the
 * verdict defaults to the routing verdict that opened the gate (`lastVerdict`). Routing is unaffected —
 * purely informational.
 */
export function buildGateSummary(
  decision: Extract<Decision, { type: 'awaitGate' }>,
  outputsByNode: Map<string, RunOutputRow[]>,
  lastVerdict: string,
): GateSummary {
  const summary: GateSummary = { nodeId: decision.nodeId, outcomes: decision.outcomes };
  const artRow = resolveGateRow(decision.gatedArtifact, outputsByNode);
  if (artRow) summary.gatedArtifact = gateArtifactView(artRow, decision.gatedArtifact?.as);
  const verdictRow = resolveGateRow(decision.verdictFrom, outputsByNode);
  if (verdictRow) summary.reviewerVerdict = gateArtifactView(verdictRow);
  // Only fall back to the routing verdict when no verdictFrom was REQUESTED — a specified-but-unresolved
  // verdictFrom must not silently present the routing verdict as if it came from that source.
  else if (!decision.verdictFrom && lastVerdict) summary.reviewerVerdict = { verdict: lastVerdict };
  return summary;
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
  const { appendEvent, appendRunOutput, awaitHuman, completeRun, failRun, blockRun, loadRunTaskContext, integrateFn, runStub, confirmMergeFn, runConfirmStub, pollPrFn, runPollStub, respondThreadsFn, runRespondStub, preflightFn, createWorktreeFn, releaseWorktreeFn } = deps;

  /** Resolve a node's `consumes` from the workflow-local output accumulator — NOT live Revisium reads
   *  (0016 §6 / consensus M4: a live read on replay can see rows written past the replay point). */
  function resolveConsumes(
    node: Node,
    outputsByNode: Map<string, RunOutputRow[]>,
  ): { inputs: Record<string, unknown> } | { missing: string } {
    const refs = 'consumes' in node ? (node.consumes ?? []) : [];
    const inputs: Record<string, unknown> = {};
    for (const ref of refs) {
      const produced = outputsByNode.get(ref.node) ?? [];
      const iteration = ref.iteration ?? 'latest';
      let value: unknown;
      let found: boolean;
      if (iteration === 'all') {
        value = produced.map((o) => o.payload);
        found = produced.length > 0;
      } else if (iteration === 'latest') {
        value = produced.length ? produced[produced.length - 1].payload : undefined;
        found = produced.length > 0;
      } else {
        const hit = produced.find((o) => o.ordinal === iteration);
        value = hit?.payload;
        found = hit !== undefined;
      }
      if (!found) {
        if (ref.optional) continue;
        return { missing: `${ref.node} as ${ref.as}` };
      }
      inputs[ref.as] = value;
    }
    return { inputs };
  }

  /** Record a node's produced output to the workflow-local accumulator + Revisium (when `produces`). */
  // (gate-summary helpers live at module scope below — they are pure over outputsByNode.)
  async function recordOutput(
    runId: string,
    node: Node,
    ordinal: number,
    output: unknown,
    outputsByNode: Map<string, RunOutputRow[]>,
  ): Promise<void> {
    if (!('produces' in node) || !node.produces) return;
    const row: RunOutputRow = {
      runId,
      nodeId: node.id,
      ordinal,
      name: node.produces.name,
      schemaRef: ('resultSchema' in node && node.resultSchema) || '',
      payload: output,
      attemptId: stepKeyFor(node.id, ordinal),
    };
    const list = outputsByNode.get(node.id) ?? [];
    list.push(row);
    outputsByNode.set(node.id, list);
    await appendRunOutput(row);
  }

  return async function dataDrivenTaskImpl(
    runId: string,
    opts: DataDrivenTaskOpts,
  ): Promise<DataDrivenResult> {
    try {
      return await runBody(runId, opts);
    } catch (err) {
      // TERMINAL failure: mark the Revisium run-row `failed` (idempotent, event-first) before
      // re-throwing so DBOS still records the workflow ERROR (progress truth) and the run-row stops
      // lying. The run's terminal-failure surfacing contract (0008 #2).
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

    // B5/B7 — live preflight: one memoized DBOS step, evaluated exactly once BEFORE the graph runs.
    // Skipped entirely when every selected binding resolves to a stub/script runner (mirrors the old
    // engine's gate). A `needsHuman` preflight blocks the run (clean/base invariant unmet) and surfaces
    // the lesson — the run never enters the graph. This is an engine-level guard (infrastructure), not a
    // template node: it is cross-cutting and identical for every pinned pipeline (zero role-ids/shapes).
    const live = route.roleBindings.some((b) => runnerNeedsLivePreflight(b.resolvedRunnerId));
    if (live) {
      // Preflight runs against the BASE checkout (resolveTaskCwd), BEFORE the worktree exists — its
      // fetch + clean/freshness checks protect the user's base repo. Ordering is load-bearing.
      const pf = await preflightFn(taskId, base);
      if ('needsHuman' in pf) {
        return await blockWithLesson(runId, taskId, 'preflight', pf.lesson, 0);
      }
    }

    // Per-run worktree (plan 0017): create AFTER a passing preflight and BEFORE any live effect, so all
    // repo-touching steps (developer/rework + integrator) resolve to the isolated worktree (keyed by
    // runId) — never the shared base checkout. Skipped for non-live runs. The `finally` releases it at a
    // SUCCEEDED terminal (the PR is merged via confirmMerge → branch is in base → worktree disposable) and
    // on a throw (failure); it KEEPS the worktree on a `blocked` terminal (confirmMerge blocks when the PR
    // isn't merged yet — the tree must survive for rework / a manual merge; reclaimed by cleanup_worktree
    // + the host-start sweep). It does NOT run while parked at a gate (awaitHuman suspends the live
    // workflow via `recv`, so runBody never returns there). Create is INSIDE the try so the release also
    // cleans up a create that partially built the worktree before throwing (codex/CodeRabbit).
    let result: DataDrivenResult | undefined;
    try {
      if (live) {
        await createWorktreeFn(runId, taskId, title, base);
      }
      result = await runGraph(runId, opts, taskId, title, base);
      return result;
    } finally {
      if (live && result?.status !== 'blocked') {
        try {
          await releaseWorktreeFn(runId, taskId);
        } catch (releaseErr) {
          console.warn(`[data-driven] worktree release for ${runId} failed (orphan; pruned later): ${String(releaseErr)}`);
        }
      }
    }
  }

  /** The pipeline-core interpretation loop, extracted so the worktree `finally` in runBody wraps it. */
  async function runGraph(
    runId: string,
    opts: DataDrivenTaskOpts,
    taskId: string,
    title: string,
    base: string,
  ): Promise<DataDrivenResult> {
    const { route, template } = opts;

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
    let lastFailureReason = '';
    let stepCount = 0;
    // Workflow-local dataflow state (0016 §4.1/§6): per-node execution ordinals + produced outputs.
    // Both are rebuilt deterministically on DBOS replay (the loop re-runs identically); the adapter
    // hydrates consumers from `outputsByNode`, never from a live Revisium read.
    const effectOrdinalByNode = new Map<string, number>();
    const outputsByNode = new Map<string, RunOutputRow[]>();

    for (let i = 0; i < MAX_STEPS; i++) {
      const { state: nextState, decision } = coreStep(template, state, lastResult);
      state = nextState;
      await deps.setProgress?.(runId, progressCursor(state, lastResult));

      if (decision.type === 'complete') {
        return await finish(runId, decision.status, lastVerdict, stepCount, lastFailureReason);
      }

      const eff = await applyDecision(decision, {
        runId, template, bindingByRef, executionProfile, taskId, title, base,
        effectOrdinalByNode, outputsByNode,
        // The verdict from the PRIOR effect (the reviewer/poller that routed into this node). At an
        // awaitGate this is the routing verdict that opened the gate → D3's default reviewerVerdict.
        lastVerdict,
      });
      stepCount += eff.stepDelta;
      // Engine-level short-circuit (agent needsHuman, classified by invokeRole): block the run at a
      // visible, lesson-bearing terminal WITHOUT routing through the core's onFailure:'abort' machinery
      // (which would fail the run). blockWithLesson emits the single `pipeline_blocked` (token-redacted
      // at the persist boundary) + marks the run-row blocked — the same guard the preflight block uses.
      if (eff.terminal) {
        await blockWithLesson(runId, taskId, eff.terminal.reason, eff.terminal.lesson, stepCount);
        return { runId, status: eff.terminal.status, verdict: 'blocked', steps: stepCount };
      }
      lastResult = eff.lastResult;
      if (eff.lastVerdict !== undefined) lastVerdict = eff.lastVerdict;
      lastFailureReason = eff.failureReason ?? '';
    }

    throw new InterpretError(
      `data-driven ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (template loop bug)`,
    );
  }

  // ── Decision dispatch ────────────────────────────────────────────────────────

  /**
   * What executing one non-terminal Decision yields back to the loop.
   *
   * `terminal` is an ENGINE-LEVEL short-circuit (set ONLY by the agent `needsHuman` branch — see
   * invokeRole): it terminates the run at the given terminal status WITHOUT routing the effect through
   * the core's failure machinery. A `needsHuman` agent must NOT be turned into a `failed`/`errorCode`
   * outcome, because the agent nodes carry `onFailure:'abort'` and (by design) no `catch` arm for a
   * human-block — so routing it as a failure would ABORT the whole run. Instead we surface it as a
   * visible, lesson-bearing `blocked` terminal, exactly as the engine-level preflight guard does
   * (blockWithLesson). The block is recovery-bearing, not a silent ResultInvalid abort.
   */
  type DecisionEffect = { lastResult: LastResult | undefined; lastVerdict?: string; failureReason?: string; stepDelta: number; terminal?: { status: TerminalStatus; reason: string; lesson: string } };
  type EffectCtx = {
    runId: string;
    template: Template;
    bindingByRef: Map<string, RouteRoleBinding>;
    executionProfile: ExecutionProfile;
    taskId: string;
    title: string;
    base: string;
    effectOrdinalByNode: Map<string, number>;
    outputsByNode: Map<string, RunOutputRow[]>;
    lastVerdict: string; //                               D3 — the prior effect's verdict (gate's default reviewerVerdict)
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
    const { runId, template, bindingByRef, taskId, title, base } = ctx;
    switch (decision.type) {
      case 'invokeRole': {
        const node = resolveNode(template, decision.nodeId);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, node.id);
        const stepKey = stepKeyFor(node.id, ordinal);
        const resolved = resolveConsumes(node, ctx.outputsByNode);
        if ('missing' in resolved) {
          // A required upstream output is absent → fail-loud as a WIRING fault (0016 §6 / consensus M3):
          // a dedicated step_failed names the missing (node, as), distinct from a domain `blocker`. The
          // node's default onFailure='abort' then routes to a failed terminal (the run fails loud).
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            payload: { nodeId: node.id, error: `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced` },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', stepDelta: 1 };
        }
        const result = await invokeRole(runId, decision, node, ctx, resolved.inputs, stepKey);
        if ('blocked' in result) {
          // needsHuman (deliberate agent block OR transient runner failure): short-circuit to a visible
          // `blocked` terminal carrying the per-kind lesson (runGraph emits the pipeline_blocked + blocks
          // the run-row via blockWithLesson). NOT a failed/aborted run — the block is recoverable.
          return { lastResult: undefined, terminal: { status: 'blocked', reason: result.reason, lesson: result.lesson }, stepDelta: 1 };
        }
        if (result.failed) {
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            payload: { nodeId: node.id, error: result.errorCode },
          });
          return { lastResult: { outcome: 'failed', errorCode: result.errorCode }, lastVerdict: 'failed', failureReason: result.reason, stepDelta: 1 };
        }
        await recordOutput(runId, node, ordinal, result.output, ctx.outputsByNode);
        const verdict = result.verdict;
        return {
          lastResult: { outcome: 'succeeded', ...(verdict ? { verdict } : {}) },
          ...(verdict ? { lastVerdict: verdict } : {}),
          stepDelta: 1,
        };
      }
      case 'invokeScript': {
        const node = resolveNode(template, decision.nodeId);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, node.id);
        // A script node may `consumes` upstream data (plan 0018: respondThreads ← triage). Hydrate it
        // from the workflow-local accumulator (same seam as agents), fail-loud on a missing required input.
        const resolved = resolveConsumes(node, ctx.outputsByNode);
        if ('missing' in resolved) {
          await appendEvent({
            runId, taskId, stepId: '', stepKey: stepKeyFor(node.id, ordinal), type: 'step_failed',
            payload: { nodeId: node.id, error: `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced` },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', stepDelta: 1 };
        }
        const scriptResult = await invokeScript(runId, decision, { taskId, title, base }, bindingByRef, stepKeyFor(node.id, ordinal), resolved.inputs);
        // A blocked script (needsHuman) routes via revo.ScriptBlocked → a `blocked` terminal; a thrown
        // script routes via revo.ScriptFailed → a `failed` terminal (§6 catch). The lesson-bearing
        // pipeline_blocked is emitted inside invokeScript for the block path (parity with the old engine).
        if (scriptResult.outcome === 'blocked') {
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_BLOCKED }, lastVerdict: 'blocked', stepDelta: 1 };
        }
        if (scriptResult.outcome === 'failed') {
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_FAILED }, lastVerdict: 'failed', stepDelta: 1 };
        }
        await recordOutput(runId, node, ordinal, scriptResult.pointer, ctx.outputsByNode);
        // A classifying script (pollPr, plan 0018) surfaces a DOMAIN verdict so the next `choice` can
        // route on it (§8). Scripts with a single fixed `next` (integrator/confirmMerge) carry none.
        const sv = scriptResult.verdict;
        return { lastResult: { outcome: 'succeeded', ...(sv ? { verdict: sv } : {}) }, ...(sv ? { lastVerdict: sv } : {}), stepDelta: 1 };
      }
      case 'awaitGate': {
        const topic = gateTopicFor(decision.reason);
        // Per-entry gate key (nodeId#ordinal) so a re-entered gate (e.g. a question gate looped in the
        // review phase) gets a DISTINCT inbox row instead of colliding on `runId|topic` (§3.2 audit).
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, decision.nodeId);
        const human = await awaitHuman(
          runId,
          topic,
          stepKeyFor(decision.nodeId, ordinal),
          `${decision.reason} approval`,
          buildGateSummary(decision, ctx.outputsByNode, ctx.lastVerdict),
        );
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
    ctx: EffectCtx,
    inputs: Record<string, unknown>,
    stepKey: string,
  ): Promise<
    | { failed: true; errorCode: typeof REVO_RESULT_INVALID; reason: string }
    | { blocked: true; reason: string; lesson: string }
    | { failed: false; verdict?: string; output: unknown }
  > {
    const binding = ctx.bindingByRef.get(decision.roleRef);
    if (!binding) {
      // A VALID template's caps resolve at run start; an unresolved roleRef is a fatal config gap.
      throw new Error(`CAPABILITY_UNRESOLVED: roleRef ${decision.roleRef} has no route binding`);
    }
    // stepKey is ordinal-aware (0016 §4.1): distinct per loop iteration, stable across replay. The
    // hydrated `inputs` (consumed upstream outputs) ride in stepInput → the runner renders them as a
    // `## Inputs (from previous steps)` prompt section (build-context).
    const stepInput =
      Object.keys(inputs).length > 0 ? { nodeId: decision.nodeId, inputs } : { nodeId: decision.nodeId };
    const result = await runStepFn(runId, binding.rowId, stepKey, stepInput, binding.resolvedRunnerId, ctx.executionProfile);
    // A `needsHuman` result is NOT a wiring fault — it is a recoverable human-block. Route it to a
    // visible `blocked` terminal (like a blocked SCRIPT), never a ResultInvalid abort (which permanently
    // kills the run). TWO distinct things produce needsHuman; both block, but the human must see WHICH:
    //  - DELIBERATE: the agent self-reported `needsHuman:true` (the result-envelope contract). It carries
    //    the agent's own `output` + `lesson` — a genuine "I need a human decision".
    //  - TRANSIENT: runStep (pipeline.service.ts) wraps a runner-process crash / non-zero exit / 429 /
    //    600s timeout as a SYNTHETIC blocking attempt — `output:{ verdict:'BLOCKER', error:'runner_failed',
    //    reason }`, needsHuman:true. This is fully recoverable; turning it into an abort killed real runs.
    // The reliable discriminator is that SYNTHETIC marker (`output.error === 'runner_failed'`), set ONLY
    // on the transient path — a deliberate agent's output is its own free-form result, never that shape.
    if (result.needsHuman) {
      // Redact token shapes at THIS build site (a lesson is free text — pushInbox/appendEvent only mask
      // secret-NAMED keys), mirroring gateArtifactView; the persist boundary redacts again, belt-and-suspenders.
      const transientReason = transientRunnerFailureReason(result);
      if (transientReason !== undefined) {
        const safe = String(redactEventPayload(transientReason));
        return { blocked: true, reason: 'runner-transient-failure', lesson: `runner-transient-failure: ${safe || 'runner failed'}` };
      }
      const safeLesson = String(redactEventPayload(result.lesson ?? `agent ${node.id} reported needsHuman`));
      return { blocked: true, reason: 'agent-needs-human', lesson: safeLesson };
    }
    if (!resultSatisfiesSchema(node, result)) {
      return { failed: true, errorCode: REVO_RESULT_INVALID, reason: `${REVO_RESULT_INVALID}: node ${node.id} result did not satisfy resultSchema ${String('resultSchema' in node ? node.resultSchema : '')}` };
    }
    const verdictProblem = resultVerdictProblem(ctx.template, node, result);
    if (verdictProblem) {
      return { failed: true, errorCode: REVO_RESULT_INVALID, reason: verdictProblem };
    }
    return { failed: false, verdict: domainVerdictOf(result), output: result.output };
  }

  /**
   * invokeScript → the built-in system SCRIPT library. The only built-in v1 script is the integrator
   * (`script:integrator`); it dispatches to the real integrator (live) or the stub (script) exactly as
   * the hardcoded path does — runner-wins via the resolved binding (D7).
   *
   * Two distinct outcomes the routing data discriminates (parity with the old engine):
   *  - `blocked`: the integrator needs a human (nothing to integrate, ambiguous PRs, refused identity,
   *    non-JSON pr view). We emit a `pipeline_blocked` event carrying the human-readable lesson (so the
   *    human sees WHY — the persist boundary redacts any token), then the node's `catch[revo.ScriptBlocked]`
   *    routes to a `blocked` terminal.
   *  - `failed`: the integrator THREW (a gh/push error). `catch[revo.ScriptFailed]` routes to a `failed`
   *    terminal; the run's top-level catch failRuns (the thrown reason is recorded, redacted).
   */
  async function invokeScript(
    runId: string,
    decision: Extract<Decision, { type: 'invokeScript' }>,
    ctx: { taskId: string; title: string; base: string },
    bindingByRef: Map<string, RouteRoleBinding>,
    stepKey: string,
    inputs: Record<string, unknown>,
  ): Promise<{ outcome: 'ok'; pointer: unknown; verdict?: string } | { outcome: 'blocked' } | { outcome: 'failed' }> {
    const isConfirmMerge = decision.scriptRef === 'script:confirmMerge';
    const isPollPr = decision.scriptRef === 'script:pollPr';
    const isRespondThreads = decision.scriptRef === 'script:respondThreads';
    const binding = bindingByRef.get(decision.scriptRef) ?? bindingByRef.get('script:integrator');
    // respondThreads consumes `triage` (plan 0018) — ride the hydrated input on the integrator input so
    // the live script can reply/resolve the triaged threads without a live Revisium read.
    const integratorInput: IntegratorInput = { runId, taskId: ctx.taskId, title: ctx.title, base: ctx.base, ...(inputs.triage !== undefined ? { triage: inputs.triage } : {}) };
    // A script node whose resolved runner mechanically performs the merge uses the REAL script;
    // otherwise the pure stub (zero git/gh). Absent a binding (template-only script), default to stub.
    const useReal = !!binding && runnerUsesRealIntegrator(binding.resolvedRunnerId);
    let result: IntegratorOutput | ConfirmMergeOutput | PrFeedback | RespondThreadsOutput | IntegratorBlocked;
    try {
      if (isConfirmMerge) {
        result = useReal ? await confirmMergeFn(integratorInput) : runConfirmStub(integratorInput);
      } else if (isPollPr) {
        result = useReal ? await pollPrFn(integratorInput) : runPollStub(integratorInput);
      } else if (isRespondThreads) {
        result = useReal ? await respondThreadsFn(integratorInput) : runRespondStub(integratorInput);
      } else {
        result = useReal ? await integrateFn(integratorInput) : runStub(integratorInput);
      }
    } catch (err) {
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'step_failed',
        payload: { scriptRef: decision.scriptRef, error: err instanceof Error ? err.message : String(err) },
      });
      return { outcome: 'failed' };
    }
    if ('needsHuman' in result) {
      // Surface the blocking reason as pipeline_blocked (the persist boundary redacts any token, D15) so
      // the human sees WHY the script could not proceed — exactly as the old engine's blockPipeline.
      const reason = isConfirmMerge ? 'confirm-merge' : isPollPr ? 'poll-pr' : isRespondThreads ? 'respond-threads' : 'integrate';
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: { reason, lesson: result.lesson, nodeId: decision.nodeId },
      });
      return { outcome: 'blocked' };
    }
    if (isConfirmMerge) {
      const merged = result as ConfirmMergeOutput;
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'merge_confirmed',
        payload: { prNumber: merged.prNumber, prUrl: merged.prUrl },
      });
      return { outcome: 'ok', pointer: { merged: true, prNumber: merged.prNumber, prUrl: merged.prUrl } };
    }
    if (isPollPr) {
      // pollPr CLASSIFIES the feedback: its verdict (review_changes/ci_changes/clean) routes the prRouter
      // choice (§8 — a script may emit a domain verdict the routing data acts on, same as an agent).
      const feedback = result as PrFeedback;
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'pr_polled',
        payload: { prNumber: feedback.prNumber, verdict: feedback.verdict, ciFailures: feedback.ciFailures.length, reviewThreads: feedback.reviewThreads.length },
      });
      return { outcome: 'ok', pointer: feedback, verdict: feedback.verdict };
    }
    if (isRespondThreads) {
      const responded = result as RespondThreadsOutput;
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'threads_responded',
        payload: { replied: responded.replied, resolved: responded.resolved },
      });
      return { outcome: 'ok', pointer: responded };
    }
    const integrated = result as IntegratorOutput;
    await appendEvent({
      runId,
      taskId: ctx.taskId,
      stepId: '',
      stepKey,
      type: 'integrate_succeeded',
      payload: { prUrl: integrated.prUrl, branch: integrated.branch, prNumber: integrated.prNumber },
    });
    return { outcome: 'ok', pointer: { prUrl: integrated.prUrl, branch: integrated.branch, prNumber: integrated.prNumber } };
  }

  /** Terminal: finish the run in Revisium per the core's terminal status. */
  async function finish(
    runId: string,
    status: TerminalStatus,
    verdict: string,
    steps: number,
    failureReason = '',
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
      await failRun(runId, failureReason || `data-driven pipeline reached a failed terminal (lastVerdict=${verdict})`);
    }
    return { runId, status, verdict, steps };
  }

  /**
   * Block the run early with a human-readable lesson (the engine-level preflight guard — there is no
   * graph node for it). Emits a lesson-bearing `pipeline_blocked` (token-redacted at the persist
   * boundary) + marks the Revisium run-row blocked, then returns a `blocked` result WITHOUT entering the
   * graph. Mirrors the old engine's `blockPipeline({ reason })`.
   */
  async function blockWithLesson(
    runId: string,
    taskId: string,
    reason: string,
    lesson: string,
    steps: number,
  ): Promise<DataDrivenResult> {
    await appendEvent({
      runId,
      taskId,
      stepId: '',
      stepKey: 'pipeline',
      type: 'pipeline_blocked',
      payload: { reason, lesson },
    });
    await blockRun(runId, { actor: 'pipeline', source: `data-driven-${reason}`, reason });
    return { runId, status: 'blocked', verdict: 'blocked', steps };
  }
}

/** Resolve a node id against the template (a VALID template never dangles — guarded defensively). */
function resolveNode(template: Template, nodeId: string): Node {
  const node = template.nodes[nodeId];
  if (!node) throw new InterpretError(`unknown node id "${nodeId}" (invalid template)`);
  return node;
}
