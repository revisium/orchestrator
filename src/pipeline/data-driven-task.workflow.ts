



























import {
  step as coreStep,
  initialState,
  validateTemplate,
  InterpretError,
  selectJoinWinner,
  reduceJoinVerdict,
  type Decision,
  type JoinArrival,
  type LastResult,
  type Node,
  type RunState,
  type Template,
  type TerminalStatus,
} from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { ExecutionProfile, RouteDecision, RouteRoleBinding } from './route-contract.js';
import { runnerNeedsLivePreflight, runnerUsesRealIntegrator } from './route-contract.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  RespondThreadsOutput,
  ProducedChangeArtifact,
  CaptureProducedChangeInput,
} from '../runners/integrator.js';
import type { AppendEventInput } from '../run/append-event.js';
import { redactEventPayload } from '../run/append-event.js';
import { redactSecrets } from '../control-plane/inbox.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { RunOutputRow } from '../run/run-outputs.js';
import { normalizeIssueRef, type IssueRef } from '../run/issue-ref.js';
import type { Decision as GateDecision } from './await-human.js';
import type { CompleteRunResult } from '../run/complete-run.js';
import type { FailRunResult } from '../run/fail-run.js';
import type { BlockRunResult } from '../run/block-run.js';
import {
  RUNNER_IDLE_TIMEOUT_KIND,
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  type RunnerTimeoutFailureKind,
} from '../worker/process-executor.js';


export type DataDrivenResult = {
  runId: string;

  status: TerminalStatus;

  verdict: string;

  steps: number;
};

export const RUN_PROGRESS_EVENT_KEY = 'run-progress';

export type DataDrivenProgressCursor = {
  activeNodeIds: string[];
  scopedCounters: Record<string, number>;
  status: RunState['status'];
  lastResult?: LastResult;
};


export type DataDrivenTaskOpts = {
  route: RouteDecision;

  template: Template;

  runnerRetryPolicy: RunnerTransientRetryPolicy;
};

const MAX_STEPS = 1_000;
const DEFAULT_RUNNER_TRANSIENT_MAX_ATTEMPTS = 2;
const DEFAULT_RUNNER_TRANSIENT_RETRY_BACKOFF_MS = 2_000;

export type RunnerTransientRetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
};

type PhysicalRunStepAttempt = {
  attemptNo: number;
  attemptId: string;
};

type RunnerRetryBlockPayload = {
  attemptsExhausted: boolean;
  attemptsMade: number;
  maxAttempts: number;
  attemptIds: string[];
  lastAttemptId: string;
  reason: string;
  lesson: string;
  failureKind?: RunnerTimeoutFailureKind;
  transientKind?: TransientRunnerFailure['transientKind'];
  timing?: unknown;
};

type InvokeRoleFailedResult = {
  failed: true;
  errorCode: typeof REVO_RESULT_INVALID;
  reason: string;
  attemptId: string;
  attemptsMade: number;
};

type InvokeRoleBlockedResult = {
  blocked: true;
  reason: string;
  lesson: string;
  retry?: RunnerRetryBlockPayload;
  attemptsMade: number;
};

type InvokeRoleSucceededResult = {
  failed: false;
  verdict?: string;
  output: unknown;
  attemptId: string;
  attemptsMade: number;
};

type InvokeRoleResult = InvokeRoleFailedResult | InvokeRoleBlockedResult | InvokeRoleSucceededResult;

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function readNonNegativeIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a non-negative integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${key} must be a non-negative integer`);
  return parsed;
}

export function resolveRunnerTransientRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RunnerTransientRetryPolicy {
  return {
    maxAttempts: readPositiveIntegerEnv(
      env,
      'REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS',
      DEFAULT_RUNNER_TRANSIENT_MAX_ATTEMPTS,
    ),
    backoffMs: readNonNegativeIntegerEnv(
      env,
      'REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS',
      DEFAULT_RUNNER_TRANSIENT_RETRY_BACKOFF_MS,
    ),
  };
}

function physicalAttemptFor(runId: string, stepKey: string, attemptNo: number): PhysicalRunStepAttempt {
  const attemptKey = `${runId}|${stepKey}|${attemptNo}`;
  return {
    attemptNo,
    attemptId: `attempt_${fnv1a64Hex(attemptKey)}`,
  };
}

function stepInputForAttempt(
  nodeId: string,
  inputs: Record<string, unknown>,
  attempt: PhysicalRunStepAttempt,
): Record<string, unknown> {
  return {
    nodeId,
    attempt: { attemptNo: attempt.attemptNo, attemptId: attempt.attemptId },
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
  };
}

function optionalTiming(timing: unknown): { timing: unknown } | Record<string, never> {
  return timing === undefined ? {} : { timing };
}

function optionalFailureKind(
  failureKind: RunnerTimeoutFailureKind | undefined,
): { failureKind: RunnerTimeoutFailureKind } | Record<string, never> {
  return failureKind === undefined ? {} : { failureKind };
}










const REVO_SCRIPT_FAILED = 'revo.ScriptFailed' as const;
const REVO_SCRIPT_BLOCKED = 'revo.ScriptBlocked' as const;
const REVO_RESULT_INVALID = 'revo.ResultInvalid' as const;
const REVO_INPUT_MISSING = 'revo.InputMissing' as const;

function invalidRoleResult(
  reason: string,
  physicalAttempt: PhysicalRunStepAttempt,
): InvokeRoleFailedResult {
  return {
    failed: true,
    errorCode: REVO_RESULT_INVALID,
    reason,
    attemptId: physicalAttempt.attemptId,
    attemptsMade: physicalAttempt.attemptNo,
  };
}

function runnerBlockReason(transient: TransientRunnerFailure): string {
  if (transient.failureKind) return transient.failureKind;
  return `runner-transient-failure:${transient.transientKind}`;
}

function runnerBlockLesson(transient: TransientRunnerFailure): string {
  const safe = String(redactEventPayload(transient.reason));
  if (transient.failureKind) return `${transient.failureKind}: ${safe || 'runner failed'}`;
  return `runner-transient-failure (${transient.transientKind}): ${safe || 'runner failed'}`;
}

function pipelineBlockedPayload(
  reason: string,
  lesson: string,
  retry: RunnerRetryBlockPayload | undefined,
): Record<string, unknown> {
  if (retry === undefined) return { reason, lesson };
  return { ...retry };
}

function stepKeyFor(nodeId: string, ordinal: number): string {
  return ordinal <= 1 ? nodeId : `${nodeId}#${ordinal}`;
}

function nextOrdinal(byNode: Map<string, number>, nodeId: string): number {
  const n = (byNode.get(nodeId) ?? 0) + 1;
  byNode.set(nodeId, n);
  return n;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function producedChangeArtifact(value: unknown): ProducedChangeArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.change) ? value.change : value;
  const branch = candidate.branch;
  const headSha = candidate.headSha;
  if (typeof branch !== 'string' || branch.trim().length === 0) return undefined;
  if (typeof headSha !== 'string' || headSha.trim().length === 0) return undefined;
  const issueRef = normalizeArtifactIssueRef(candidate.issueRef);
  return {
    branch,
    headSha,
    ...(issueRef ? { issueRef } : {}),
    ...(typeof candidate.worktreePath === 'string' && candidate.worktreePath.trim() ? { worktreePath: candidate.worktreePath } : {}),
    ...(typeof candidate.artifactRef === 'string' && candidate.artifactRef.trim() ? { artifactRef: candidate.artifactRef } : {}),
    ...(typeof candidate.prNumber === 'number' && Number.isSafeInteger(candidate.prNumber) ? { prNumber: candidate.prNumber } : {}),
  };
}

function normalizeArtifactIssueRef(value: unknown): IssueRef | undefined {
  try {
    return normalizeIssueRef(value, 'change.issueRef');
  } catch {
    return undefined;
  }
}

function changeWithRunIssueRef(change: ProducedChangeArtifact, issueRef?: IssueRef): ProducedChangeArtifact {
  const normalized = { ...change };
  if (issueRef) {
    normalized.issueRef = issueRef;
  } else {
    delete normalized.issueRef;
  }
  return normalized;
}

function producedChangeFromInputs(inputs: Record<string, unknown>): ProducedChangeArtifact | undefined {
  for (const key of ['reviewChange', 'ciChange', 'reworkChange', 'developerChange', 'change']) {
    const artifact = producedChangeArtifact(inputs[key]);
    if (artifact) return artifact;
  }
  return undefined;
}

function mergeReadinessFromInputs(inputs: Record<string, unknown>): IntegratorInput['mergeReadiness'] | undefined {
  const value = inputs.mergeReadiness;
  if (!isRecord(value)) return undefined;
  const headSha = value.headSha;
  if (typeof headSha !== 'string' || headSha.trim().length === 0) return undefined;
  return { headSha };
}

function attachProducedChange(output: unknown, change: ProducedChangeArtifact): unknown {
  if (isRecord(output)) return { ...output, change };
  return { summary: output, change };
}

function nodeProducesChange(node: Node): boolean {
  return (node.kind === 'agent' || node.kind === 'script') &&
    node.produces?.name === 'change' &&
    node.resultSchema === 'schema:change';
}

function runnerProducesWorktreeChanges(runnerId: string): boolean {
  return runnerId === 'claude-code' || runnerId === 'codex';
}

function artifactRefFromResult(result: AttemptResult): string | undefined {
  const artifacts = result.artifacts;
  const processArtifact = isRecord(artifacts) && isRecord(artifacts.process) ? artifacts.process : artifacts;
  if (!isRecord(processArtifact)) return undefined;
  return typeof processArtifact.ref === 'string' ? processArtifact.ref : undefined;
}









type TransientRunnerFailure = {
  reason: string;
  transientKind: 'timeout' | 'rate_limit' | 'crash' | 'unknown';
  retryable: boolean;
  retryableCandidate: boolean;
  failureKind?: RunnerTimeoutFailureKind;
  timing?: unknown;
};

function publicTimeoutFailureKind(value: unknown): RunnerTimeoutFailureKind | undefined {
  return value === RUNNER_IDLE_TIMEOUT_KIND || value === RUNNER_WALL_CLOCK_LIMIT_KIND
    ? value
    : undefined;
}

function transientRunnerFailure(result: AttemptResult): TransientRunnerFailure | undefined {
  const output = result.output;
  if (!isRecord(output) || output.error !== 'runner_failed') return undefined;
  const reason = typeof output.reason === 'string' ? output.reason : '';
  const failureKind = publicTimeoutFailureKind(output.failureKind);
  const legacyKind = transientKind(reason);
  const retryableCandidate = output.retryableCandidate !== false;
  return {
    reason,
    transientKind: failureKind ? 'timeout' : legacyKind,
    retryableCandidate,
    retryable: retryableCandidate && (failureKind !== undefined || legacyKind !== 'unknown'),
    ...optionalFailureKind(failureKind),
    ...optionalTiming(output.timing),
  };
}




function transientKind(reason: string): TransientRunnerFailure['transientKind'] {
  if (/exceeded\s*\d+\s*ms|timed?\s*out|\btimeout\b/i.test(reason)) return 'timeout';
  if (/\b429\b|rate.?limit|session limit/i.test(reason)) return 'rate_limit';
  if (isLegacyRetryableCrashReason(reason)) return 'crash';
  return 'unknown';
}

function isLegacyRetryableCrashReason(reason: string): boolean {
  if (
    /\b(auth|credential|permission|forbidden|denied|unauthori[sz]ed|config|schema|malformed|parseable|invalid|RUNNER_NOT_IMPLEMENTED|not wired|unknown runner|requires an OpenAI|ENOENT|not found)\b/i
      .test(reason)
  ) {
    return false;
  }
  return /\b(signal|crash(?:ed)?|killed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|ENOMEM|EAGAIN)\b/i
    .test(reason);
}


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




function resultSatisfiesSchema(node: Node, result: AttemptResult): boolean {
  if (!('resultSchema' in node) || !node.resultSchema) return true;
  const output = result.output;
  if (output === null || output === undefined) return false;
  if (typeof output === 'string') return output.length > 0;
  if (isRecord(output)) return true;
  return Array.isArray(output);
}



export type DataDrivenTaskDeps = {
  appendEvent: (input: AppendEventInput) => Promise<void>;

  appendRunOutput: (input: RunOutputRow) => Promise<void>;

  setProgress?: (runId: string, cursor: DataDrivenProgressCursor) => Promise<void>;

  sleep: (ms: number) => Promise<void>;

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

  loadRunTaskContext: (runId: string) => Promise<{ taskId: string; title: string; base: string; repoRef: string; issueRef?: IssueRef }>;

  integrateFn: (input: IntegratorInput) => Promise<IntegratorOutput | IntegratorBlocked>;

  runStub: (input: IntegratorInput) => IntegratorOutput;

  confirmMergeFn: (input: IntegratorInput) => Promise<ConfirmMergeOutput | IntegratorBlocked>;

  runConfirmStub: (input: IntegratorInput) => ConfirmMergeOutput;

  pollPrFn: (input: IntegratorInput) => Promise<PrFeedback | IntegratorBlocked>;

  runPollStub: (input: IntegratorInput) => PrFeedback;

  respondThreadsFn: (input: IntegratorInput) => Promise<RespondThreadsOutput | IntegratorBlocked>;

  runRespondStub: (input: IntegratorInput) => RespondThreadsOutput;


  captureChangeFn: (input: CaptureProducedChangeInput) => Promise<ProducedChangeArtifact>;



  preflightFn: (taskId: string, base: string) => Promise<{ ok: true } | { needsHuman: true; lesson: string }>;





  createWorktreeFn: (runId: string, taskId: string, title: string, base: string, issueRef?: IssueRef) => Promise<{ worktreePath: string }>;
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






function gateVerdict(decision: GateDecision, outcomes: string[]): string | undefined {
  if (decision.decision === 'approve') return outcomes[0];
  return outcomes.length > 1 ? outcomes.at(-1) : undefined;
}








function gateTopicFor(reason: string): 'plan' | 'merge' | 'question' {
  if (/merge/i.test(reason)) return 'merge';
  if (/question/i.test(reason)) return 'question';
  return 'plan';
}

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


function resolveGateRow(
  ref: { node: string; iteration?: 'latest' | 'all' | number } | undefined,
  outputsByNode: Map<string, RunOutputRow[]>,
): RunOutputRow | undefined {
  if (!ref) return undefined;
  const produced = outputsByNode.get(ref.node) ?? [];
  if (produced.length === 0) return undefined;
  if (typeof ref.iteration === 'number') return produced.find((o) => o.ordinal === ref.iteration);
  return produced[produced.length - 1];
}






function gateArtifactView(row: RunOutputRow, as?: string): GateArtifactView {
  const base = { nodeId: row.nodeId, name: as ?? row.name, schemaRef: row.schemaRef };
  const safe = redactEventPayload(redactSecrets(row.payload) ?? null);
  const serialized = JSON.stringify(safe ?? null);
  if (Buffer.byteLength(serialized, 'utf8') <= GATE_ARTIFACT_MAX) return { ...base, payload: safe };
  return {
    ...base,
    truncated: true,
    preview: serialized.slice(0, GATE_PREVIEW_CHARS),
    payloadRef: `attempt:${row.attemptId ?? ''}`,
  };
}





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
  else if (!decision.verdictFrom && lastVerdict) summary.reviewerVerdict = { verdict: lastVerdict };
  return summary;
}





export function makeDataDrivenTask(
  runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    resolvedRunnerId?: string,
    executionProfile?: ExecutionProfile,
    physicalAttempt?: PhysicalRunStepAttempt,
    acceptedVerdicts?: readonly string[],
  ) => Promise<AttemptResult>,
  deps: DataDrivenTaskDeps,
) {
  const { appendEvent, appendRunOutput, awaitHuman, completeRun, failRun, blockRun, loadRunTaskContext, integrateFn, runStub, confirmMergeFn, runConfirmStub, pollPrFn, runPollStub, respondThreadsFn, runRespondStub, captureChangeFn, preflightFn, createWorktreeFn, releaseWorktreeFn } = deps;

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


  async function recordOutput(
    runId: string,
    node: Node,
    ordinal: number,
    attemptId: string,
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
      attemptId,
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

    const diagnostics = validateTemplate(template).filter((d) => d.severity === 'error');
    if (diagnostics.length > 0) {
      throw new Error(
        `PINNED_TEMPLATE_INVALID: ${template.pipelineId} — ${diagnostics.map((d) => d.code).join(', ')}`,
      );
    }

    const { taskId, title, base, issueRef } = await loadRunTaskContext(runId);

    const live = route.roleBindings.some((b) => runnerNeedsLivePreflight(b.resolvedRunnerId));
    if (live) {
      const pf = await preflightFn(taskId, base);
      if ('needsHuman' in pf) {
        return await blockWithLesson(runId, taskId, 'preflight', pf.lesson, 0);
      }
    }

    if (live) {
      await createWorktreeFn(runId, taskId, title, base, issueRef);
    }
    return runGraph(runId, opts, taskId, title, base, issueRef, live);
  }


  async function runGraph(
    runId: string,
    opts: DataDrivenTaskOpts,
    taskId: string,
    title: string,
    base: string,
    issueRef: IssueRef | undefined,
    live: boolean,
  ): Promise<DataDrivenResult> {
    const { route, template, runnerRetryPolicy } = opts;

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
        runId, template, state, bindingByRef, executionProfile, taskId, title, base, issueRef,
        effectOrdinalByNode, outputsByNode, runnerRetryPolicy,
        live,
        lastVerdict,
      });
      stepCount += eff.stepDelta;
      if (eff.terminal) {
        return await blockWithLesson(
          runId,
          taskId,
          eff.terminal.reason,
          eff.terminal.lesson,
          stepCount,
          eff.terminal.retry,
        );
      }
      if (eff.stateOverride) {
        state = eff.stateOverride;
        await deps.setProgress?.(runId, progressCursor(state, eff.lastResult));
      }
      lastResult = eff.lastResult;
      if (eff.lastVerdict !== undefined) lastVerdict = eff.lastVerdict;
      lastFailureReason = eff.failureReason ?? '';
    }

    throw new InterpretError(
      `data-driven ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (template loop bug)`,
    );
  }











  type DecisionEffect = {
    lastResult: LastResult | undefined;
    lastVerdict?: string;
    failureReason?: string;
    stepDelta: number;
    terminal?: { status: 'blocked'; reason: string; lesson: string; retry?: RunnerRetryBlockPayload };
    stateOverride?: RunState;
  };
  type EffectCtx = {
    runId: string;
    template: Template;
    state: RunState;
    bindingByRef: Map<string, RouteRoleBinding>;
    executionProfile: ExecutionProfile;
    taskId: string;
    title: string;
    base: string;
    issueRef?: IssueRef;
    live: boolean;
    effectOrdinalByNode: Map<string, number>;
    outputsByNode: Map<string, RunOutputRow[]>;
    runnerRetryPolicy: RunnerTransientRetryPolicy;
    lastVerdict: string;
  };
  type ForkDecision = Extract<Decision, { type: 'fork' }>;
  type BranchExecutionResult = {
    arrival?: JoinArrival;
    terminal?: DecisionEffect['terminal'];
    stepDelta: number;
  };
  type InvokeRoleAttemptInput = {
    runId: string;
    decision: Extract<Decision, { type: 'invokeRole' }>;
    node: Node;
    ctx: EffectCtx;
    inputs: Record<string, unknown>;
    stepKey: string;
    binding: RouteRoleBinding;
  };
  type NeedsHumanRoleResult = 'retry' | InvokeRoleBlockedResult | undefined;

  function branchTemplateForJoin(template: Template, joinId: string): Template {
    const join = resolveNode(template, joinId);
    if (join.kind !== 'join') throw new InterpretError(`fork target ${joinId} is not a join (${join.kind})`);
    return {
      ...template,
      nodes: {
        ...template.nodes,
        [joinId]: { id: joinId, kind: 'terminal', status: 'succeeded' },
      },
    };
  }

  async function executeForkBranches(
    decision: ForkDecision,
    ctx: EffectCtx,
  ): Promise<DecisionEffect> {
    const branchTemplate = branchTemplateForJoin(ctx.template, decision.joinId);
    const results = await Promise.all(
      decision.branches.map((branch, idx) => executeForkBranch(branchTemplate, decision, branch, idx + 1, ctx)),
    );
    const stepDelta = results.reduce((sum, result) => sum + result.stepDelta, 0);
    const terminal = results.find((result) => result.terminal)?.terminal;
    if (terminal) return { lastResult: undefined, terminal, stepDelta };

    const arrivals = results.flatMap((result) => result.arrival ? [result.arrival] : []);
    if (arrivals.length !== decision.branches.length) {
      throw new InterpretError(
        `fork ${decision.nodeId} expected ${decision.branches.length} branch arrivals, got ${arrivals.length}`,
      );
    }
    const lastResult: LastResult = { joinArrivals: arrivals };
    const winner = selectJoinWinner(decision.mode, arrivals, decision.joinId);
    const join = resolveNode(ctx.template, decision.joinId);
    if (join.kind !== 'join') throw new InterpretError(`fork target ${decision.joinId} is not a join (${join.kind})`);
    const verdict = reduceJoinVerdict(join, arrivals, winner);
    return {
      lastResult,
      ...(verdict !== undefined ? { lastVerdict: verdict } : {}),
      stateOverride: {
        ...ctx.state,
        activeNodeIds: new Set([decision.joinId]),
        status: 'running',
        lastResult,
      },
      stepDelta,
    };
  }

  async function executeForkBranch(
    branchTemplate: Template,
    decision: ForkDecision,
    branch: ForkDecision['branches'][number],
    seq: number,
    ctx: EffectCtx,
  ): Promise<BranchExecutionResult> {
    let state: RunState = {
      ...ctx.state,
      activeNodeIds: new Set([branch.entry]),
      scopedCounters: { ...ctx.state.scopedCounters },
      status: 'running',
      lastResult: undefined,
    };
    let lastResult: LastResult | undefined;
    let lastVerdict = '';
    let stepDelta = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      const next = coreStep(branchTemplate, state, lastResult);
      state = next.state;
      if (next.decision.type === 'complete') {
        if (next.decision.status !== 'succeeded') {
          throw new InterpretError(
            `fork ${decision.nodeId} branch ${branch.id} completed ${next.decision.status} before join ${decision.joinId}`,
          );
        }
        return {
          arrival: {
            branchId: branch.id,
            seq,
            ...(lastVerdict ? { verdict: lastVerdict } : {}),
          },
          stepDelta,
        };
      }

      const eff = await applyDecision(next.decision, {
        ...ctx,
        template: branchTemplate,
        state,
        lastVerdict,
      });
      stepDelta += eff.stepDelta;
      if (eff.terminal) return { terminal: eff.terminal, stepDelta };
      if (eff.stateOverride) state = eff.stateOverride;
      lastResult = eff.lastResult;
      if (eff.lastVerdict !== undefined) lastVerdict = eff.lastVerdict;
    }

    throw new InterpretError(
      `fork ${decision.nodeId} branch ${branch.id} did not reach join ${decision.joinId} within ${MAX_STEPS} steps`,
    );
  }

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
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            payload: { nodeId: node.id, error: `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced` },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', stepDelta: 1 };
        }
        const result = await invokeRole(runId, decision, node, ctx, resolved.inputs, stepKey);
        if ('blocked' in result) {
          return {
            lastResult: undefined,
            terminal: {
              status: 'blocked',
              reason: result.reason,
              lesson: result.lesson,
              ...(result.retry ? { retry: result.retry } : {}),
            },
            stepDelta: result.attemptsMade,
          };
        }
        if (result.failed) {
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            idempotencyKey: result.attemptId,
            payload: { nodeId: node.id, error: result.errorCode },
          });
          return { lastResult: { outcome: 'failed', errorCode: result.errorCode }, lastVerdict: 'failed', failureReason: result.reason, stepDelta: result.attemptsMade };
        }
        await recordOutput(runId, node, ordinal, result.attemptId, result.output, ctx.outputsByNode);
        const verdict = result.verdict;
        return {
          lastResult: { outcome: 'succeeded', ...(verdict ? { verdict } : {}) },
          ...(verdict ? { lastVerdict: verdict } : {}),
          stepDelta: result.attemptsMade,
        };
      }
      case 'invokeScript': {
        const node = resolveNode(template, decision.nodeId);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, node.id);
        const resolved = resolveConsumes(node, ctx.outputsByNode);
        if ('missing' in resolved) {
          await appendEvent({
            runId, taskId, stepId: '', stepKey: stepKeyFor(node.id, ordinal), type: 'step_failed',
            payload: { nodeId: node.id, error: `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced` },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', stepDelta: 1 };
        }
        const scriptResult = await invokeScript(runId, decision, { taskId, title, base, issueRef: ctx.issueRef }, bindingByRef, stepKeyFor(node.id, ordinal), resolved.inputs);
        if (scriptResult.outcome === 'blocked') {
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_BLOCKED }, lastVerdict: 'blocked', stepDelta: 1 };
        }
        if (scriptResult.outcome === 'failed') {
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_FAILED }, lastVerdict: 'failed', stepDelta: 1 };
        }
        await recordOutput(runId, node, ordinal, stepKeyFor(node.id, ordinal), scriptResult.pointer, ctx.outputsByNode);
        const sv = scriptResult.verdict;
        return { lastResult: { outcome: 'succeeded', ...(sv ? { verdict: sv } : {}) }, ...(sv ? { lastVerdict: sv } : {}), stepDelta: 1 };
      }
      case 'awaitGate': {
        const topic = gateTopicFor(decision.reason);
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
        await appendEvent({
          runId,
          taskId,
          stepId: '',
          stepKey: `fork:${decision.nodeId}`,
          type: 'pipeline_fork',
          payload: { nodeId: decision.nodeId, branches: decision.branches.map((b) => b.id), joinId: decision.joinId },
        });
        return executeForkBranches(decision, ctx);
      }
      case 'startTimer':
        return { lastResult: {}, stepDelta: 0 };
    }
  }



  async function invokeRole(
    runId: string,
    decision: Extract<Decision, { type: 'invokeRole' }>,
    node: Node,
    ctx: EffectCtx,
    inputs: Record<string, unknown>,
    stepKey: string,
  ): Promise<InvokeRoleResult> {
    const binding = resolveRoleBinding(ctx, decision);
    return invokeRoleAttempts({ runId, decision, node, ctx, inputs, stepKey, binding });
  }

  function resolveRoleBinding(
    ctx: EffectCtx,
    decision: Extract<Decision, { type: 'invokeRole' }>,
  ): RouteRoleBinding {
    const binding = ctx.bindingByRef.get(decision.roleRef);
    if (binding === undefined) {
      throw new Error(`CAPABILITY_UNRESOLVED: roleRef ${decision.roleRef} has no route binding`);
    }
    return binding;
  }

  async function invokeRoleAttempts(input: InvokeRoleAttemptInput): Promise<InvokeRoleResult> {
    const { runId, decision, node, ctx, inputs, stepKey, binding } = input;
    const attemptIds: string[] = [];

    for (let attemptNo = 1; attemptNo <= ctx.runnerRetryPolicy.maxAttempts; attemptNo++) {
      const physicalAttempt = physicalAttemptFor(runId, stepKey, attemptNo);
      attemptIds.push(physicalAttempt.attemptId);
      const result = await runStepFn(
        runId,
        binding.rowId,
        stepKey,
        stepInputForAttempt(decision.nodeId, inputs, physicalAttempt),
        binding.resolvedRunnerId,
        ctx.executionProfile,
        physicalAttempt,
        ctx.template.verdicts.domain,
      );

      const needsHuman = await maybeHandleNeedsHumanRoleResult({
        ...input,
        attemptIds,
        physicalAttempt,
        result,
      });
      if (needsHuman === 'retry') continue;
      if (needsHuman) return needsHuman;

      const failed = roleValidationFailure(ctx.template, node, result, physicalAttempt);
      if (failed) return failed;

      let output = result.output;
      const hasProducedChange = producedChangeArtifact(output) !== undefined;
      const shouldCaptureChange =
        nodeProducesChange(node) &&
        !hasProducedChange &&
        ctx.live &&
        runnerProducesWorktreeChanges(binding.resolvedRunnerId);
      if (shouldCaptureChange) {
        const artifactRef = artifactRefFromResult(result);
        const change = await captureChangeFn({
          runId,
          taskId: ctx.taskId,
          title: ctx.title,
          base: ctx.base,
          nodeId: node.id,
          attemptId: physicalAttempt.attemptId,
          ...(ctx.issueRef ? { issueRef: ctx.issueRef } : {}),
          ...(artifactRef ? { artifactRef } : {}),
        });
        output = attachProducedChange(output, change);
      }

      return {
        failed: false,
        verdict: domainVerdictOf(result),
        output,
        attemptId: physicalAttempt.attemptId,
        attemptsMade: attemptNo,
      };
    }

    throw new InterpretError(`runner retry loop for ${stepKey} exceeded maxAttempts`);
  }

  async function maybeHandleNeedsHumanRoleResult(
    input: InvokeRoleAttemptInput & {
      attemptIds: string[];
      physicalAttempt: PhysicalRunStepAttempt;
      result: AttemptResult;
    },
  ): Promise<NeedsHumanRoleResult> {
    const { result, node, physicalAttempt } = input;
    if (result.needsHuman) {
      const transient = transientRunnerFailure(result);
      if (transient === undefined) {
        const safeLesson = String(redactEventPayload(result.lesson ?? `agent ${node.id} reported needsHuman`));
        return { blocked: true, reason: 'agent-needs-human', lesson: safeLesson, attemptsMade: physicalAttempt.attemptNo };
      }
      return handleTransientRoleResult({ ...input, transient });
    }

    return undefined;
  }

  async function handleTransientRoleResult(
    input: InvokeRoleAttemptInput & {
      attemptIds: string[];
      physicalAttempt: PhysicalRunStepAttempt;
      transient: TransientRunnerFailure;
    },
  ): Promise<'retry' | InvokeRoleBlockedResult> {
    const { runId, node, ctx, stepKey, attemptIds, physicalAttempt, transient } = input;
    const policy = ctx.runnerRetryPolicy;
    if (shouldRetryTransient(transient, physicalAttempt, policy)) {
      const nextAttempt = physicalAttemptFor(runId, stepKey, physicalAttempt.attemptNo + 1);
      await appendRunnerRetryScheduled({
        runId,
        taskId: ctx.taskId,
        stepKey,
        nodeId: node.id,
        failedAttempt: physicalAttempt,
        nextAttempt,
        policy,
        transient,
      });
      if (policy.backoffMs > 0) await deps.sleep(policy.backoffMs);
      return 'retry';
    }

    const retry = runnerRetryBlockPayload({
      transient,
      attemptIds,
      lastAttempt: physicalAttempt,
      policy,
      attemptsExhausted: transient.retryable && physicalAttempt.attemptNo >= policy.maxAttempts,
    });
    if (retry.attemptsExhausted) {
      await appendRunnerRetryExhausted({
        runId,
        taskId: ctx.taskId,
        stepKey,
        nodeId: node.id,
        retry,
        idempotencyKey: physicalAttempt.attemptId,
      });
    }
    return {
      blocked: true,
      reason: retry.reason,
      lesson: retry.lesson,
      retry,
      attemptsMade: physicalAttempt.attemptNo,
    };
  }

  function shouldRetryTransient(
    transient: TransientRunnerFailure,
    attempt: PhysicalRunStepAttempt,
    policy: RunnerTransientRetryPolicy,
  ): boolean {
    return transient.retryable && attempt.attemptNo < policy.maxAttempts;
  }

  function roleValidationFailure(
    template: Template,
    node: Node,
    result: AttemptResult,
    physicalAttempt: PhysicalRunStepAttempt,
  ): InvokeRoleFailedResult | undefined {
    if (resultSatisfiesSchema(node, result)) {
      const verdictProblem = resultVerdictProblem(template, node, result);
      if (verdictProblem) return invalidRoleResult(verdictProblem, physicalAttempt);
      return undefined;
    }
    return invalidRoleResult(
      `${REVO_RESULT_INVALID}: node ${node.id} result did not satisfy resultSchema ${String('resultSchema' in node ? node.resultSchema : '')}`,
      physicalAttempt,
    );
  }

  function runnerRetryBlockPayload(input: {
    transient: TransientRunnerFailure;
    attemptIds: string[];
    lastAttempt: PhysicalRunStepAttempt;
    policy: RunnerTransientRetryPolicy;
    attemptsExhausted: boolean;
  }): RunnerRetryBlockPayload {
    const { transient, attemptIds, lastAttempt, policy, attemptsExhausted } = input;
    const reason = runnerBlockReason(transient);
    const lesson = runnerBlockLesson(transient);
    return {
      attemptsExhausted,
      attemptsMade: lastAttempt.attemptNo,
      maxAttempts: policy.maxAttempts,
      attemptIds: [...attemptIds],
      lastAttemptId: lastAttempt.attemptId,
      reason,
      lesson,
      ...optionalFailureKind(transient.failureKind),
      transientKind: transient.transientKind,
      ...optionalTiming(transient.timing),
    };
  }

  async function appendRunnerRetryScheduled(input: {
    runId: string;
    taskId: string;
    stepKey: string;
    nodeId: string;
    failedAttempt: PhysicalRunStepAttempt;
    nextAttempt: PhysicalRunStepAttempt;
    policy: RunnerTransientRetryPolicy;
    transient: TransientRunnerFailure;
  }): Promise<void> {
    const { runId, taskId, stepKey, nodeId, failedAttempt, nextAttempt, policy, transient } = input;
    await appendEvent({
      runId,
      taskId,
      stepId: '',
      stepKey,
      type: 'runner_retry_scheduled',
      idempotencyKey: failedAttempt.attemptId,
      payload: {
        nodeId,
        failedAttemptNo: failedAttempt.attemptNo,
        failedAttemptId: failedAttempt.attemptId,
        nextAttemptNo: nextAttempt.attemptNo,
        nextAttemptId: nextAttempt.attemptId,
        maxAttempts: policy.maxAttempts,
        backoffMs: policy.backoffMs,
        reason: runnerBlockReason(transient),
        lesson: runnerBlockLesson(transient),
        ...optionalFailureKind(transient.failureKind),
        transientKind: transient.transientKind,
        ...optionalTiming(transient.timing),
      },
    });
  }

  async function appendRunnerRetryExhausted(input: {
    runId: string;
    taskId: string;
    stepKey: string;
    nodeId: string;
    retry: RunnerRetryBlockPayload;
    idempotencyKey: string;
  }): Promise<void> {
    const { runId, taskId, stepKey, nodeId, retry, idempotencyKey } = input;
    await appendEvent({
      runId,
      taskId,
      stepId: '',
      stepKey,
      type: 'runner_retry_exhausted',
      idempotencyKey,
      payload: {
        nodeId,
        ...retry,
      },
    });
  }












  async function invokeScript(
    runId: string,
    decision: Extract<Decision, { type: 'invokeScript' }>,
    ctx: { taskId: string; title: string; base: string; issueRef?: IssueRef },
    bindingByRef: Map<string, RouteRoleBinding>,
    stepKey: string,
    inputs: Record<string, unknown>,
  ): Promise<{ outcome: 'ok'; pointer: unknown; verdict?: string } | { outcome: 'blocked' } | { outcome: 'failed' }> {
    if (decision.scriptRef === 'script:cleanupWorktree') {
      try { await releaseWorktreeFn(runId, ctx.taskId); } catch { /* best-effort */ }
      await appendEvent({ runId, taskId: ctx.taskId, stepId: '', stepKey, type: 'worktree_released', payload: { nodeId: decision.nodeId } });
      return { outcome: 'ok', pointer: { released: true } };
    }
    const isConfirmMerge = decision.scriptRef === 'script:confirmMerge';
    const isPollPr = decision.scriptRef === 'script:pollPr';
    const isRespondThreads = decision.scriptRef === 'script:respondThreads';
    const binding = bindingByRef.get(decision.scriptRef) ?? bindingByRef.get('script:integrator');
    const change = producedChangeFromInputs(inputs);
    const mergeReadiness = mergeReadinessFromInputs(inputs);
    const issueRef = ctx.issueRef;
    const changeForIntegrator = change ? changeWithRunIssueRef(change, issueRef) : undefined;
    const integratorInput: IntegratorInput = {
      runId,
      taskId: ctx.taskId,
      title: ctx.title,
      base: ctx.base,
      ...(issueRef ? { issueRef } : {}),
      ...(changeForIntegrator ? { change: changeForIntegrator } : {}),
      ...(inputs.triage === undefined ? {} : { triage: inputs.triage }),
      ...(mergeReadiness ? { mergeReadiness } : {}),
    };
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
        payload: {
          prNumber: merged.prNumber,
          prUrl: merged.prUrl,
          ...(merged.issueRef ? { issueRef: merged.issueRef } : {}),
        },
      });
      return {
        outcome: 'ok',
        pointer: {
          merged: true,
          prNumber: merged.prNumber,
          prUrl: merged.prUrl,
          ...(merged.issueRef ? { issueRef: merged.issueRef } : {}),
        },
      };
    }
    if (isPollPr) {
      const feedback = result as PrFeedback;
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'pr_polled',
        payload: {
          prNumber: feedback.prNumber,
          headSha: feedback.headSha,
          verdict: feedback.verdict,
          evidence: feedback.evidence,
          ciFailures: feedback.ciFailures.length,
          reviewThreads: feedback.reviewThreads.length,
          ...(feedback.issueRef ? { issueRef: feedback.issueRef } : {}),
        },
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
      payload: {
        prUrl: integrated.prUrl,
        branch: integrated.branch,
        prNumber: integrated.prNumber,
        headSha: integrated.headSha,
        status: integrated.status,
        ...(integrated.issueRef ? { issueRef: integrated.issueRef } : {}),
      },
    });
    return {
      outcome: 'ok',
      pointer: {
        prUrl: integrated.prUrl,
        branch: integrated.branch,
        prNumber: integrated.prNumber,
        headSha: integrated.headSha,
        status: integrated.status,
        ...(integrated.issueRef ? { issueRef: integrated.issueRef } : {}),
      },
    };
  }


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





  async function blockWithLesson(
    runId: string,
    taskId: string,
    reason: string,
    lesson: string,
    steps: number,
    retry?: RunnerRetryBlockPayload,
  ): Promise<DataDrivenResult> {
    await appendEvent({
      runId,
      taskId,
      stepId: '',
      stepKey: 'pipeline',
      type: 'pipeline_blocked',
      payload: pipelineBlockedPayload(reason, lesson, retry),
    });
    await blockRun(runId, { actor: 'pipeline', source: `data-driven-${reason}`, reason });
    return { runId, status: 'blocked', verdict: 'blocked', steps };
  }
}


function resolveNode(template: Template, nodeId: string): Node {
  const node = template.nodes[nodeId];
  if (!node) throw new InterpretError(`unknown node id "${nodeId}" (invalid template)`);
  return node;
}
