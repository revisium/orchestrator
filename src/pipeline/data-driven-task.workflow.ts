



























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
import type { RouteDecision } from './route-contract.js';
import { executionPlanFromRouteDecision } from './route-contract.js';
import type { ResolvedAgentBinding, ResolvedScriptBinding } from '../control-plane/run-profile-contract.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  MergeOverrideOutput,
  RespondThreadsOutput,
  ProducedChangeArtifact,
  CaptureProducedChangeInput,
} from '../runners/integrator.js';
import type { AppendEventInput } from '../run/append-event.js';
import { redactEventPayload } from '../run/append-event.js';
import { redactSecrets } from '../control-plane/inbox.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import type { RunOutputRow } from '../run/run-outputs.js';
import { normalizeIssueAction, normalizeIssueRef, type IssueAction, type IssueRef } from '../run/issue-ref.js';
import type { Decision as GateDecision, GateTopic } from './await-human.js';
import type { CompleteRunResult } from '../run/complete-run.js';
import type { FailRunResult } from '../run/fail-run.js';
import type { BlockRunResult } from '../run/block-run.js';
import type { CancelRunResult } from '../run/cancel-run.js';
import {
  RUNNER_IDLE_TIMEOUT_KIND,
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  type RunnerTimeoutFailureKind,
} from '../worker/process-executor.js';
import type { WorktreeReleaseResult } from '../runners/worktree.service.js';


export type DataDrivenResult = {
  runId: string;

  status: TerminalStatus;

  verdict: string;

  steps: number;
};

export const RUN_PROGRESS_EVENT_KEY = 'run-progress';
export const INTEGRATOR_PROGRESS_EVENT_TYPES = ['integrate_succeeded', 'foreign_pr_adopted'] as const;

export type DataDrivenProgressCursor = {
  activeNodeIds: string[];
  scopedCounters: Record<string, number>;
  status: RunState['status'];
  lastResult?: LastResult;
};


export type DataDrivenTaskOpts = {
  route: RouteDecision;
  runnerRetryPolicy: RunnerTransientRetryPolicy;
};

const MAX_STEPS = 1_000;
const DEFAULT_RUNNER_TRANSIENT_MAX_ATTEMPTS = 2;
const DEFAULT_RUNNER_TRANSIENT_RETRY_BACKOFF_MS = 2_000;

export function resolvePinnedAgentBinding(
  bindings: ReadonlyMap<string, ResolvedAgentBinding>,
  nodeId: string,
): ResolvedAgentBinding {
  const binding = bindings.get(`node:${nodeId}`);
  if (binding === undefined) {
    throw new Error(`execution_plan_binding_unresolved: agent node ${nodeId} has no pinned binding`);
  }
  return binding;
}

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

const TRANSIENT_RETRY_GATE_OUTCOMES = ['retry', 'give_up'] as const;
type TransientRetryGateOutcome = typeof TRANSIENT_RETRY_GATE_OUTCOMES[number];

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
  recovery?: VerificationEnvironmentRecovery;
  attemptsMade: number;
};

type AgentQuestionRetryContext = {
  kind: 'agent_question';
  nodeId: string;
  answer: unknown;
  lesson: string;
  inboxId: string;
  resolvedBy: string;
};

type UnresolvedAgentQuestion = {
  unresolved: true;
  reason: string;
  lesson: string;
};

type RetryRoleResult = {
  action: 'retry';
};

type InvokeRoleQuestionResult = {
  question: true;
  retryContext: AgentQuestionRetryContext;
  attemptsMade: number;
};

type InvokeRoleSucceededResult = {
  failed: false;
  verdict?: string;
  output: unknown;
  attemptId: string;
  attemptsMade: number;
};

type InvokeRoleResult =
  | InvokeRoleFailedResult
  | InvokeRoleBlockedResult
  | InvokeRoleQuestionResult
  | InvokeRoleSucceededResult;

type VerificationEnvironmentRecovery = {
  classification: 'verification_environment';
  nodeId: string;
  stepKey: string;
  role: string;
  runner: string;
  reason: string;
  lesson: string;
  attemptId: string;
  artifactRef?: string;
};

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
  retryContext?: AgentQuestionRetryContext,
): Record<string, unknown> {
  return {
    nodeId,
    attempt: { attemptNo: attempt.attemptNo, attemptId: attempt.attemptId },
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(retryContext ? { retryContext } : {}),
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

function transientRetryGateOutcome(decision: GateDecision): TransientRetryGateOutcome {
  const answer = isRecord(decision.answer) ? decision.answer : {};
  let outcome = '';
  if (typeof decision.outcome === 'string') {
    outcome = decision.outcome;
  } else if (typeof answer.outcome === 'string') {
    outcome = answer.outcome;
  }
  if (outcome === 'retry') return 'retry';
  return 'give_up';
}

function producedChangeArtifact(value: unknown): ProducedChangeArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = isRecord(value.change) ? value.change : value;
  const branch = candidate.branch;
  const headSha = candidate.headSha;
  if (typeof branch !== 'string' || branch.trim().length === 0) return undefined;
  if (typeof headSha !== 'string' || headSha.trim().length === 0) return undefined;
  const issueRef = normalizeArtifactIssueRef(candidate.issueRef);
  const issueAction = normalizeArtifactIssueAction(candidate.issueAction);
  return {
    branch,
    headSha,
    ...(issueRef ? { issueRef } : {}),
    ...(issueAction ? { issueAction } : {}),
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

function normalizeArtifactIssueAction(value: unknown): IssueAction | undefined {
  try {
    return normalizeIssueAction(value, 'change.issueAction');
  } catch {
    return undefined;
  }
}

function changeWithRunIssueContract(change: ProducedChangeArtifact, issueRef?: IssueRef, issueAction?: IssueAction): ProducedChangeArtifact {
  const normalized = { ...change };
  if (issueRef) {
    normalized.issueRef = issueRef;
  } else {
    delete normalized.issueRef;
  }
  if (issueAction) {
    normalized.issueAction = issueAction;
  } else {
    delete normalized.issueAction;
  }
  return normalized;
}

function producedChangeFromInputs(inputs: Record<string, unknown>): ProducedChangeArtifact | undefined {
  for (const key of ['reviewChange', 'ciChange', 'stuckReworkChange', 'reworkChange', 'developerChange', 'change']) {
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
  const override = isRecord(value.override) && value.override.accepted === true
    ? { accepted: true }
    : undefined;
  return { headSha, ...(override ? { override } : {}) };
}

function headShaFromPayload(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const headSha = value.headSha;
  return typeof headSha === 'string' && headSha.trim().length > 0 ? headSha.trim() : undefined;
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

function recoveryContextAfterNode(nodeId: string, recoveryContext: RunOutputRow | undefined): RunOutputRow | null | undefined {
  if (!recoveryContext) return undefined;
  return nodeId === 'classifyRecovery' ? recoveryContext : null;
}

const LIVE_WORKTREE_SCRIPT_REFS = new Set([
  'script:integrator',
  'script:confirmMerge',
  'script:pollPr',
  'script:overrideMerge',
  'script:respondThreads',
]);

function scriptRequiresLiveWorktree(scriptRef: string): boolean {
  return LIVE_WORKTREE_SCRIPT_REFS.has(scriptRef);
}

function templateRequiresLiveWorktree(template: Template): boolean {
  return Object.values(template.nodes).some((node) =>
    node.kind === 'script' && scriptRequiresLiveWorktree(node.scriptRef),
  );
}

function artifactRefFromResult(result: AttemptResult): string | undefined {
  const artifacts = result.artifacts;
  const processArtifact = isRecord(artifacts) && isRecord(artifacts.process) ? artifacts.process : artifacts;
  if (!isRecord(processArtifact)) return undefined;
  return typeof processArtifact.ref === 'string' ? processArtifact.ref : undefined;
}









type TransientRunnerFailure = {
  reason: string;
  transientKind: 'timeout' | 'rate_limit' | 'overloaded' | 'crash' | 'unknown';
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
  if (/\b529\b|overloaded/i.test(reason)) return 'overloaded';
  if (isLegacyRetryableCrashReason(reason)) return 'crash';
  return 'unknown';
}

function verificationEnvironmentBlock(result: AttemptResult, nodeId: string): { reason: string; lesson: string } | undefined {
  const text = [
    result.verdict,
    result.lesson,
    typeof result.output === 'string' ? result.output : undefined,
    isRecord(result.output) ? result.output.reason : undefined,
    isRecord(result.output) ? result.output.error : undefined,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  if (!/\b(verification|verify|test|lint|check|socket|loopback|sandbox|permission|capability|read.?only)\b/i.test(text)) {
    return undefined;
  }
  if (!/\b(sandbox|permission|denied|read.?only|eperm|eacces|operation not permitted|socket|loopback|listen eaddrnotavail|missing capability|capability|network access|filesystem|fs sandbox)\b/i.test(text)) {
    return undefined;
  }
  const lesson = String(redactEventPayload(result.lesson ?? text.trim() ?? `agent ${nodeId} verification is environment-blocked`));
  return { reason: 'verification-environment-blocked', lesson };
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
    topic: GateTopic,
    gateKey: string,
    title: string,
    summary: unknown,
    options?: string[],
    kind?: 'approval' | 'question',
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
  cancelRun: (
    runId: string,
    opts?: { actor?: string; source?: string },
  ) => Promise<CancelRunResult | null>;

  loadRunTaskContext: (runId: string) => Promise<{ taskId: string; title: string; base: string; repoRef: string; issueRef?: IssueRef; issueAction?: IssueAction }>;

  integrateFn: (input: IntegratorInput) => Promise<IntegratorOutput | IntegratorBlocked>;

  confirmMergeFn: (input: IntegratorInput) => Promise<ConfirmMergeOutput | IntegratorBlocked>;

  pollPrFn: (input: IntegratorInput) => Promise<PrFeedback | IntegratorBlocked>;

  overrideMergeFn: (input: IntegratorInput) => Promise<MergeOverrideOutput | IntegratorBlocked>;

  respondThreadsFn: (input: IntegratorInput) => Promise<RespondThreadsOutput | IntegratorBlocked>;

  captureChangeFn: (input: CaptureProducedChangeInput) => Promise<ProducedChangeArtifact>;



  preflightFn: (taskId: string, base: string) => Promise<{ ok: true } | { needsHuman: true; lesson: string }>;





  createWorktreeFn: (runId: string, taskId: string, title: string, base: string, issueRef?: IssueRef) => Promise<{ worktreePath: string }>;
  releaseWorktreeFn: (runId: string, taskId: string) => Promise<WorktreeReleaseResult>;
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
  if (decision.outcome) return outcomes.includes(decision.outcome) ? decision.outcome : undefined;
  if (decision.decision === 'approve') return outcomes[0];
  return outcomes.length > 1 ? outcomes.at(-1) : undefined;
}

type GateResolutionMetadata = {
  note?: string;
  resolvedBy: string;
  resolvedAt: string;
  inboxId?: string;
  mergeOverrideAudit?: unknown;
  adoptionAudit?: unknown;
};

function gateResolutionMetadata(
  decision: GateDecision,
  fallbackInboxId?: string,
): GateResolutionMetadata {
  const decisionRecord: Record<string, unknown> = isRecord(decision) ? decision : {};
  const answer = isRecord(decision.answer) ? decision.answer : {};
  const note = decision.note ?? (typeof answer.note === 'string' ? answer.note : undefined);
  const resolvedBy = decision.resolvedBy ?? (typeof answer.resolvedBy === 'string' ? answer.resolvedBy : '');
  const resolvedAt = decision.resolvedAt ?? (typeof answer.resolvedAt === 'string' ? answer.resolvedAt : '');
  const inboxId = decision.inboxId ?? (typeof answer.inboxId === 'string' ? answer.inboxId : fallbackInboxId);
  const mergeOverrideAudit = answer.mergeOverrideAudit ?? decisionRecord['mergeOverrideAudit'];
  const adoptionAudit = answer.adoptionAudit ?? decisionRecord['adoptionAudit'];
  return {
    ...(note !== undefined ? { note } : {}),
    resolvedBy,
    resolvedAt,
    ...(inboxId !== undefined ? { inboxId } : {}),
    ...(mergeOverrideAudit !== undefined ? { mergeOverrideAudit } : {}),
    ...(adoptionAudit !== undefined ? { adoptionAudit } : {}),
  };
}

function gateResolutionOutput(
  decision: GateDecision,
  verdict: string | undefined,
  fallbackInboxId: string,
  trustedGateHeadSha?: string | null,
): Record<string, unknown> {
  const resolution = gateResolutionMetadata(decision, fallbackInboxId);
  return {
    outcome: decision.outcome ?? verdict ?? decision.decision,
    ...(resolution.note !== undefined ? { note: resolution.note } : {}),
    resolvedBy: resolution.resolvedBy,
    resolvedAt: resolution.resolvedAt,
    inboxId: resolution.inboxId ?? fallbackInboxId,
    ...(trustedGateHeadSha !== undefined ? { trustedGateHeadSha } : {}),
    ...(resolution.mergeOverrideAudit !== undefined ? { mergeOverrideAudit: resolution.mergeOverrideAudit } : {}),
    ...(resolution.adoptionAudit !== undefined ? { adoptionAudit: resolution.adoptionAudit } : {}),
    ...(decision.decision ? { decision: decision.decision } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSyntheticGateTimeoutFallback(decision: GateDecision): boolean {
  const answer = isRecord(decision.answer) ? decision.answer : {};
  return decision.decision === 'reject' && answer.reason === 'gate-timeout';
}

function agentQuestionRetryContext(
  decision: GateDecision,
  nodeId: string,
  safeLesson: string,
): AgentQuestionRetryContext | undefined {
  if (isSyntheticGateTimeoutFallback(decision)) return undefined;
  const resolution = gateResolutionMetadata(decision);
  const inboxId = nonEmptyString(resolution.inboxId);
  const resolvedBy = nonEmptyString(resolution.resolvedBy);
  if (!inboxId || !resolvedBy) return undefined;
  return {
    kind: 'agent_question',
    nodeId,
    answer: decision.answer,
    lesson: safeLesson,
    inboxId,
    resolvedBy,
  };
}

function unresolvedAgentQuestionLesson(
  nodeId: string,
  safeLesson: string,
  decision: GateDecision,
): string {
  const reason = isSyntheticGateTimeoutFallback(decision)
    ? 'agent question timed out'
    : 'agent question resolution is missing inboxId or resolvedBy';
  return `${reason} for ${nodeId}; original question: ${safeLesson}`;
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

function freshMergeGateArtifact(
  decision: Extract<Decision, { type: 'awaitGate' }>,
  lastVerdict: string,
  lastProducedOutput?: RunOutputRow,
): RunOutputRow | undefined {
  if (decision.nodeId !== 'mergeGate') return undefined;
  if (lastProducedOutput?.nodeId === 'mergeRecheck' && lastVerdict === 'clean') return lastProducedOutput;
  if (lastProducedOutput?.nodeId === 'mergeApproveReverify' && lastVerdict === 'recheck') return lastProducedOutput;
  return undefined;
}

function latestBlockedScriptArtifact(
  decision: Extract<Decision, { type: 'awaitGate' }>,
  recoveryContext?: RunOutputRow,
): RunOutputRow | undefined {
  if (decision.nodeId !== 'recoveryGate') return undefined;
  const payload = recoveryContext?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  return typeof record.lesson === 'string' && typeof record.reason === 'string' ? recoveryContext : undefined;
}





export function buildGateSummary(
  decision: Extract<Decision, { type: 'awaitGate' }>,
  outputsByNode: Map<string, RunOutputRow[]>,
  lastVerdict: string,
  lastProducedOutput?: RunOutputRow,
  recoveryContext?: RunOutputRow,
): GateSummary {
  const summary: GateSummary = { nodeId: decision.nodeId, outcomes: decision.outcomes };
  const artRow = latestBlockedScriptArtifact(decision, recoveryContext)
    ?? freshMergeGateArtifact(decision, lastVerdict, lastProducedOutput)
    ?? resolveGateRow(decision.gatedArtifact, outputsByNode);
  if (artRow) summary.gatedArtifact = gateArtifactView(artRow, decision.gatedArtifact?.as);
  const verdictRow = resolveGateRow(decision.verdictFrom, outputsByNode);
  if (verdictRow) summary.reviewerVerdict = gateArtifactView(verdictRow);
  else if (!decision.verdictFrom && lastVerdict) summary.reviewerVerdict = { verdict: lastVerdict };
  return summary;
}

function approvedMergeGateHeadSha(
  decision: Extract<Decision, { type: 'awaitGate' }>,
  verdict: string | undefined,
  summary: GateSummary,
): string | null | undefined {
  if (decision.nodeId !== 'mergeGate') return undefined;
  if (verdict === 'approved' || verdict === 'override_merge') {
    return headShaFromPayload(summary.gatedArtifact?.payload) ?? null;
  }
  return null;
}

function approvedHeadMove(
  decision: Extract<Decision, { type: 'invokeScript' }>,
  approvedHeadSha: string | undefined,
  pointer: unknown,
  verdict: string | undefined,
): { approvedHeadSha: string; reverifyHeadSha: string } | undefined {
  if (decision.nodeId !== 'mergeApproveReverify' || verdict !== 'clean' || approvedHeadSha === undefined) return undefined;
  const reverifyHeadSha = headShaFromPayload(pointer);
  if (reverifyHeadSha === undefined || reverifyHeadSha === approvedHeadSha) return undefined;
  return { approvedHeadSha, reverifyHeadSha };
}

function reapprovalRequiredFeedback(pointer: unknown, approvedHeadSha: string, reverifyHeadSha: string): unknown {
  if (!isRecord(pointer)) return pointer;
  const evidence = Array.isArray(pointer.evidence)
    ? pointer.evidence.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    ...pointer,
    verdict: 'recheck',
    evidence: [
      ...evidence,
      `approved mergeGate headSha=${approvedHeadSha}; reverify headSha=${reverifyHeadSha}; reapproval required`,
    ],
  };
}

function reopenNodeState(state: RunState, nodeId: string): RunState {
  return { ...state, activeNodeIds: new Set([nodeId]), status: 'running' };
}





export type ScriptResult =
  | { outcome: 'ok'; pointer: unknown; verdict?: string }
  | { outcome: 'blocked'; pointer?: unknown }
  | { outcome: 'failed'; reason?: string };

type SystemScriptInvocation = {
  runId: string;
  decision: Extract<Decision, { type: 'invokeScript' }>;
  ctx: { taskId: string; title: string; base: string; issueRef?: IssueRef; issueAction?: IssueAction };
  bindingByNode: Map<string, ResolvedAgentBinding>;
  scriptBindings?: ResolvedScriptBinding[];
  stepKey: string;
  inputs: Record<string, unknown>;
};

type SystemScriptHandler = (inv: SystemScriptInvocation) => Promise<ScriptResult>;

type ScriptRegistryDeps = Pick<
  DataDrivenTaskDeps,
  | 'appendEvent'
  | 'releaseWorktreeFn'
  | 'integrateFn'
  | 'confirmMergeFn'
  | 'pollPrFn'
  | 'overrideMergeFn'
  | 'respondThreadsFn'
>;

function integratorResultPointer(result: IntegratorOutput): Record<string, unknown> {
  return {
    prUrl: result.prUrl,
    branch: result.branch,
    prNumber: result.prNumber,
    headSha: result.headSha,
    status: result.status,
    ...(result.issueRef ? { issueRef: result.issueRef } : {}),
    ...(result.foreignPr ? { foreignPr: true } : {}),
    ...(result.prAuthor ? { prAuthor: result.prAuthor } : {}),
    ...(result.integratorAccount ? { integratorAccount: result.integratorAccount } : {}),
  };
}

type IntegratorProgressEventType = typeof INTEGRATOR_PROGRESS_EVENT_TYPES[number];

function integratorProgressEventType(result: IntegratorOutput): IntegratorProgressEventType {
  return result.foreignPr ? 'foreign_pr_adopted' : 'integrate_succeeded';
}

function mergeOverrideEventPayload(result: MergeOverrideOutput): Record<string, unknown> {
  const audit = result.override.audit;
  return {
    actor: result.override.actor,
    note: result.override.note,
    reason: audit?.reason ?? result.override.reason ?? '',
    risk: audit?.risk ?? '',
    verificationResponsibility: audit?.verificationResponsibility ?? '',
    headSha: audit?.headSha ?? result.headSha,
    freshHeadSha: result.headSha,
    prNumber: result.prNumber,
    source: result.override.source,
    overriddenFacts: result.override.facts,
    replied: result.override.replied,
    resolved: result.override.resolved,
    ...(result.override.reason ? { refusalReason: result.override.reason } : {}),
  };
}

function scriptGithubAccount(
  decision: Extract<Decision, { type: 'invokeScript' }>,
  scriptBindings: ResolvedScriptBinding[] | undefined,
): string | undefined {
  return scriptBindings?.find((binding) => binding.nodeId === decision.nodeId)?.accountAliases.github;
}

export function buildSystemScriptRegistry(deps: ScriptRegistryDeps): Map<string, SystemScriptHandler> {
  const {
    appendEvent,
    releaseWorktreeFn,
    integrateFn,
    confirmMergeFn,
    pollPrFn,
    overrideMergeFn,
    respondThreadsFn,
  } = deps;

  function buildIntegratorInput(
    runId: string,
    ctx: SystemScriptInvocation['ctx'],
    inputs: Record<string, unknown>,
    githubAccount?: string,
  ): IntegratorInput {
    const { taskId, title, base, issueRef, issueAction } = ctx;
    const change = producedChangeFromInputs(inputs);
    const mergeReadiness = mergeReadinessFromInputs(inputs);
    const changeForIntegrator = change ? changeWithRunIssueContract(change, issueRef, issueAction) : undefined;
    return {
      runId,
      taskId,
      title,
      base,
      ...(githubAccount ? { githubAccount } : {}),
      ...(issueRef ? { issueRef } : {}),
      ...(issueAction ? { issueAction } : {}),
      ...(changeForIntegrator ? { change: changeForIntegrator } : {}),
      ...(inputs.triage === undefined ? {} : { triage: inputs.triage }),
      ...(inputs.gateResolution === undefined ? {} : { gateResolution: inputs.gateResolution }),
      ...(mergeReadiness ? { mergeReadiness } : {}),
    };
  }

  function makeIntegratorScript<TSuccess>(desc: {
    real: (input: IntegratorInput) => Promise<TSuccess | IntegratorBlocked>;
    blockedReason: string;
    mapSuccess: (result: TSuccess) => { eventType: string; payload: Record<string, unknown>; pointer: unknown; verdict?: string };
  }): SystemScriptHandler {
    return async ({ runId, decision, ctx, scriptBindings, stepKey, inputs }) => {
      const integratorInput = buildIntegratorInput(runId, ctx, inputs, scriptGithubAccount(decision, scriptBindings));
      let result: TSuccess | IntegratorBlocked;
      try {
        result = await desc.real(integratorInput);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        await appendEvent({
          runId, taskId: ctx.taskId, stepId: '', stepKey,
          type: 'step_failed',
          payload: { scriptRef: decision.scriptRef, error: reason },
        });
        return { outcome: 'failed', reason };
      }
      if ('needsHuman' in (result as object)) {
        const pointer = {
          reason: desc.blockedReason,
          lesson: (result as IntegratorBlocked).lesson,
          nodeId: decision.nodeId,
        };
        await appendEvent({
          runId, taskId: ctx.taskId, stepId: '', stepKey: 'pipeline',
          type: 'pipeline_blocked',
          payload: pointer,
        });
        return { outcome: 'blocked', pointer };
      }
      const { eventType, payload, pointer, verdict } = desc.mapSuccess(result as TSuccess);
      await appendEvent({ runId, taskId: ctx.taskId, stepId: '', stepKey, type: eventType, payload });
      return { outcome: 'ok', pointer, ...(verdict !== undefined ? { verdict } : {}) };
    };
  }

  const cleanupWorktree: SystemScriptHandler = async ({ runId, decision, ctx, stepKey }) => {
    let releaseResult: WorktreeReleaseResult;
    try {
      releaseResult = await releaseWorktreeFn(runId, ctx.taskId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'cleanup_failed',
        payload: { nodeId: decision.nodeId, error, released: false },
      });
      return { outcome: 'ok', pointer: { released: false, error } };
    }
    if (!releaseResult.released) {
      const pointer = {
        released: false,
        reason: releaseResult.reason,
        worktreePath: releaseResult.worktreePath,
      };
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'cleanup_failed',
        payload: { nodeId: decision.nodeId, ...pointer },
      });
      return { outcome: 'ok', pointer };
    }
    await appendEvent({ runId, taskId: ctx.taskId, stepId: '', stepKey, type: 'worktree_released', payload: { nodeId: decision.nodeId } });
    return { outcome: 'ok', pointer: { released: true } };
  };

  const integratorScript = makeIntegratorScript({
    real: integrateFn,
    blockedReason: 'integrate',
    mapSuccess: (result: IntegratorOutput) => ({
      eventType: integratorProgressEventType(result),
      payload: integratorResultPointer(result),
      pointer: integratorResultPointer(result),
    }),
  });

  const confirmMergeScript = makeIntegratorScript({
    real: confirmMergeFn,
    blockedReason: 'confirm-merge',
    mapSuccess: (result: ConfirmMergeOutput) => ({
      eventType: 'merge_confirmed',
      payload: {
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        ...(result.issueRef ? { issueRef: result.issueRef } : {}),
      },
      pointer: {
        merged: true,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        ...(result.issueRef ? { issueRef: result.issueRef } : {}),
      },
    }),
  });

  const pollPrScript = makeIntegratorScript({
    real: pollPrFn,
    blockedReason: 'poll-pr',
    mapSuccess: (result: PrFeedback) => ({
      eventType: 'pr_polled',
      payload: {
        prNumber: result.prNumber,
        headSha: result.headSha,
        verdict: result.verdict,
        evidence: result.evidence,
        ciFailures: result.ciFailures.length,
        reviewThreads: result.reviewThreads.length,
        ...(result.issueRef ? { issueRef: result.issueRef } : {}),
      },
      pointer: result,
      verdict: result.verdict,
    }),
  });

  const overrideMergeScript: SystemScriptHandler = async ({ runId, decision, ctx, scriptBindings, stepKey, inputs }) => {
    const integratorInput = buildIntegratorInput(runId, ctx, inputs, scriptGithubAccount(decision, scriptBindings));
    let result: MergeOverrideOutput | IntegratorBlocked;
    try {
      result = await overrideMergeFn(integratorInput);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await appendEvent({
        runId, taskId: ctx.taskId, stepId: '', stepKey,
        type: 'step_failed',
        payload: { scriptRef: decision.scriptRef, error: reason },
      });
      return { outcome: 'failed', reason };
    }
    if ('needsHuman' in result) {
      const pointer = { reason: 'override-merge', lesson: result.lesson, nodeId: decision.nodeId };
      await appendEvent({
        runId, taskId: ctx.taskId, stepId: '', stepKey: 'pipeline',
        type: 'pipeline_blocked',
        payload: pointer,
      });
      return { outcome: 'blocked', pointer };
    }
    if (result.override.replied > 0 || result.override.resolved > 0) {
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'threads_responded',
        payload: { replied: result.override.replied, resolved: result.override.resolved },
      });
    }
    if (result.override.accepted || result.verdict !== 'merged') {
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: result.override.accepted ? 'merge_overridden' : 'merge_override_refused',
        payload: mergeOverrideEventPayload(result),
      });
    }
    return { outcome: 'ok', pointer: result, verdict: result.verdict };
  };

  const respondThreadsScript = makeIntegratorScript({
    real: respondThreadsFn,
    blockedReason: 'respond-threads',
    mapSuccess: (result: RespondThreadsOutput) => ({
      eventType: 'threads_responded',
      payload: { replied: result.replied, resolved: result.resolved },
      pointer: result,
    }),
  });

  return new Map<string, SystemScriptHandler>([
    ['script:cleanupWorktree', cleanupWorktree],
    ['script:confirmMerge', confirmMergeScript],
    ['script:pollPr', pollPrScript],
    ['script:overrideMerge', overrideMergeScript],
    ['script:respondThreads', respondThreadsScript],
    ['script:integrator', integratorScript],
  ]);
}

export function makeDataDrivenTask(
  runStepFn: (
    runId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    binding: ResolvedAgentBinding,
    physicalAttempt?: PhysicalRunStepAttempt,
    acceptedVerdicts?: readonly string[],
  ) => Promise<AttemptResult>,
  deps: DataDrivenTaskDeps,
) {
  const { appendEvent, appendRunOutput, awaitHuman, completeRun, failRun, blockRun, cancelRun, loadRunTaskContext, captureChangeFn, preflightFn, createWorktreeFn } = deps;
  const scriptRegistry = buildSystemScriptRegistry(deps);

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
  ): Promise<RunOutputRow | undefined> {
    if (!('produces' in node) || !node.produces) return undefined;
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
    return row;
  }

  async function recordRecoveryContext(
    runId: string,
    node: Node,
    ordinal: number,
    attemptId: string,
    payload: unknown,
    outputsByNode: Map<string, RunOutputRow[]>,
  ): Promise<RunOutputRow> {
    const row: RunOutputRow = {
      runId,
      nodeId: node.id,
      ordinal,
      name: 'recoveryContext',
      schemaRef: 'schema:recoveryContext',
      payload,
      attemptId,
    };
    const list = outputsByNode.get(node.id) ?? [];
    list.push(row);
    outputsByNode.set(node.id, list);
    await appendRunOutput(row);
    return row;
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
    const { route } = opts;
    const plan = executionPlanFromRouteDecision(route);
    const template = plan.pipeline.executableGraph as Template;

    const diagnostics = validateTemplate(template).filter((d) => d.severity === 'error');
    if (diagnostics.length > 0) {
      throw new Error(
        `PINNED_TEMPLATE_INVALID: ${template.pipelineId} — ${diagnostics.map((d) => d.code).join(', ')}`,
      );
    }

    const { taskId, title, base, issueRef, issueAction } = await loadRunTaskContext(runId);

    const live =
      plan.agentBindings.some((binding) => binding.runner.capabilities.worktreeChanges === true) ||
      templateRequiresLiveWorktree(template);
    if (live) {
      const pf = await preflightFn(taskId, base);
      if ('needsHuman' in pf) {
        return await blockWithLesson(runId, taskId, 'preflight', pf.lesson, 0);
      }
    }

    if (live) {
      await createWorktreeFn(runId, taskId, title, base, issueRef);
    }
    return runGraph(runId, opts, taskId, title, base, issueRef, issueAction, live);
  }


  async function runGraph(
    runId: string,
    opts: DataDrivenTaskOpts,
    taskId: string,
    title: string,
    base: string,
    issueRef: IssueRef | undefined,
    issueAction: IssueAction | undefined,
    live: boolean,
  ): Promise<DataDrivenResult> {
    const { route, runnerRetryPolicy } = opts;

    const plan = executionPlanFromRouteDecision(route);
    const template = plan.pipeline.executableGraph as Template;
    const bindingByNode = new Map<string, ResolvedAgentBinding>();
    for (const binding of plan.agentBindings) {
      bindingByNode.set(`node:${binding.nodeId}`, binding);
    }
    const scriptBindings = plan.scriptBindings;

    let state: RunState = initialState(template);
    let lastResult: LastResult | undefined;
    let lastVerdict = '';
    let lastProducedOutput: RunOutputRow | undefined;
    let recoveryContext: RunOutputRow | undefined;
    let lastFailureReason = '';
    let approvedMergeGateHeadShaValue: string | undefined;
    let stepCount = 0;
    const effectOrdinalByNode = new Map<string, number>();
    const outputsByNode = new Map<string, RunOutputRow[]>();
    const agentQuestionRetryContextByNode = new Map<string, AgentQuestionRetryContext>();

    for (let i = 0; i < MAX_STEPS; i++) {
      const { state: nextState, decision } = coreStep(template, state, lastResult);
      state = nextState;
      await deps.setProgress?.(runId, progressCursor(state, lastResult));

      if (decision.type === 'complete') {
        return await finish(runId, decision.status, lastVerdict, stepCount, lastFailureReason);
      }

      const eff = await applyDecision(decision, {
        runId, template, state, bindingByNode, scriptBindings, taskId, title, base, issueRef, issueAction,
        effectOrdinalByNode, outputsByNode, runnerRetryPolicy, agentQuestionRetryContextByNode,
        live,
        lastVerdict,
        lastProducedOutput,
        recoveryContext,
        approvedMergeGateHeadSha: approvedMergeGateHeadShaValue,
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
      lastVerdict = eff.lastVerdict ?? lastVerdict;
      lastProducedOutput = eff.producedOutput ?? lastProducedOutput;
      if ('recoveryContext' in eff) recoveryContext = eff.recoveryContext ?? undefined;
      lastFailureReason = eff.failureReason ?? '';
      if (eff.approvedMergeGateHeadSha !== undefined) {
        approvedMergeGateHeadShaValue = eff.approvedMergeGateHeadSha ?? undefined;
      }
    }

    throw new InterpretError(
      `data-driven ${template.pipelineId} did not terminate within ${MAX_STEPS} steps (template loop bug)`,
    );
  }











  type DecisionEffect = {
    lastResult: LastResult | undefined;
    lastVerdict?: string;
    producedOutput?: RunOutputRow;
    recoveryContext?: RunOutputRow | null;
    failureReason?: string;
    approvedMergeGateHeadSha?: string | null;
    stepDelta: number;
    terminal?: { status: 'blocked'; reason: string; lesson: string; retry?: RunnerRetryBlockPayload };
    stateOverride?: RunState;
  };
  type EffectCtx = {
    runId: string;
    template: Template;
    state: RunState;
    bindingByNode: Map<string, ResolvedAgentBinding>;
    scriptBindings: ResolvedScriptBinding[];
    taskId: string;
    title: string;
    base: string;
    issueRef?: IssueRef;
    issueAction?: IssueAction;
    live: boolean;
    effectOrdinalByNode: Map<string, number>;
    outputsByNode: Map<string, RunOutputRow[]>;
    runnerRetryPolicy: RunnerTransientRetryPolicy;
    agentQuestionRetryContextByNode: Map<string, AgentQuestionRetryContext>;
    lastVerdict: string;
    lastProducedOutput?: RunOutputRow;
    recoveryContext?: RunOutputRow;
    approvedMergeGateHeadSha?: string;
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
    binding: ResolvedAgentBinding;
    retryContext?: AgentQuestionRetryContext;
  };
  type NeedsHumanRoleResult = RetryRoleResult | InvokeRoleBlockedResult | InvokeRoleQuestionResult | undefined;

  function forkBranchArrival(
    decision: ForkDecision,
    branch: ForkDecision['branches'][number],
    seq: number,
    status: 'succeeded' | 'failed' | 'cancelled' | 'blocked',
    lastVerdict: string,
  ): JoinArrival {
    if (status !== 'succeeded') {
      throw new InterpretError(
        `fork ${decision.nodeId} branch ${branch.id} completed ${status} before join ${decision.joinId}`,
      );
    }
    return {
      branchId: branch.id,
      seq,
      ...(lastVerdict ? { verdict: lastVerdict } : {}),
    };
  }

  function recoveryContextFromEffect(
    current: RunOutputRow | undefined,
    effect: DecisionEffect,
  ): RunOutputRow | undefined {
    return 'recoveryContext' in effect ? effect.recoveryContext ?? undefined : current;
  }

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
    let lastProducedOutput: RunOutputRow | undefined;
    let recoveryContext: RunOutputRow | undefined;
    let stepDelta = 0;

    for (let i = 0; i < MAX_STEPS; i++) {
      const next = coreStep(branchTemplate, state, lastResult);
      state = next.state;
      if (next.decision.type === 'complete') {
        return {
          arrival: forkBranchArrival(decision, branch, seq, next.decision.status, lastVerdict),
          stepDelta,
        };
      }

      const eff = await applyDecision(next.decision, {
        ...ctx,
        template: branchTemplate,
        state,
        lastVerdict,
        lastProducedOutput,
        recoveryContext,
      });
      stepDelta += eff.stepDelta;
      if (eff.terminal) return { terminal: eff.terminal, stepDelta };
      state = eff.stateOverride ?? state;
      lastResult = eff.lastResult;
      lastVerdict = eff.lastVerdict ?? lastVerdict;
      lastProducedOutput = eff.producedOutput ?? lastProducedOutput;
      recoveryContext = recoveryContextFromEffect(recoveryContext, eff);
    }

    throw new InterpretError(
      `fork ${decision.nodeId} branch ${branch.id} did not reach join ${decision.joinId} within ${MAX_STEPS} steps`,
    );
  }

  async function applyDecision(
    decision: Exclude<Decision, { type: 'complete' }>,
    ctx: EffectCtx,
  ): Promise<DecisionEffect> {
    const { runId, template, bindingByNode, taskId, title, base } = ctx;
    switch (decision.type) {
      case 'invokeRole': {
        const node = resolveNode(template, decision.nodeId);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, node.id);
        const stepKey = stepKeyFor(node.id, ordinal);
        const resolved = resolveConsumes(node, ctx.outputsByNode);
        if ('missing' in resolved) {
          const reason = `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced`;
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            payload: { nodeId: node.id, error: reason },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', failureReason: reason, stepDelta: 1 };
        }
        const result = await invokeRole(runId, decision, node, ctx, resolved.inputs, stepKey);
        if ('question' in result) {
          ctx.agentQuestionRetryContextByNode.set(node.id, result.retryContext);
          return {
            lastResult: undefined,
            stateOverride: reopenNodeState(ctx.state, node.id),
            stepDelta: result.attemptsMade,
          };
        }
        if ('blocked' in result) {
          if (result.recovery) {
            ctx.agentQuestionRetryContextByNode.delete(node.id);
            const recovery = await awaitVerificationRecoveryGate(runId, ctx, result.recovery);
            return {
              lastResult: undefined,
              terminal: {
                status: 'blocked',
                reason: recovery.reason,
                lesson: recovery.lesson,
              },
              stepDelta: result.attemptsMade,
            };
          }
          if (result.retry?.attemptsExhausted) {
            const retryOutcome = await awaitTransientRetryGate(runId, ctx, {
              node,
              stepKey,
              binding: resolveRoleBinding(ctx, decision),
              retry: result.retry,
            });
            if (retryOutcome === 'retry') {
              return {
                lastResult: undefined,
                stateOverride: reopenNodeState(ctx.state, node.id),
                stepDelta: result.attemptsMade,
              };
            }
          }
          ctx.agentQuestionRetryContextByNode.delete(node.id);
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
          ctx.agentQuestionRetryContextByNode.delete(node.id);
          await appendEvent({
            runId, taskId, stepId: '', stepKey, type: 'step_failed',
            idempotencyKey: result.attemptId,
            payload: { nodeId: node.id, error: result.errorCode, reason: result.reason },
          });
          return { lastResult: { outcome: 'failed', errorCode: result.errorCode }, lastVerdict: 'failed', failureReason: result.reason, stepDelta: result.attemptsMade };
        }
        ctx.agentQuestionRetryContextByNode.delete(node.id);
        const producedOutput = await recordOutput(runId, node, ordinal, result.attemptId, result.output, ctx.outputsByNode);
        const verdict = result.verdict;
        return {
          lastResult: { outcome: 'succeeded', ...(verdict ? { verdict } : {}) },
          ...(verdict ? { lastVerdict: verdict } : {}),
          ...(producedOutput ? { producedOutput } : {}),
          ...(ctx.recoveryContext ? { recoveryContext: recoveryContextAfterNode(node.id, ctx.recoveryContext) } : {}),
          stepDelta: result.attemptsMade,
        };
      }
      case 'invokeScript': {
        const node = resolveNode(template, decision.nodeId);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, node.id);
        const resolved = resolveConsumes(node, ctx.outputsByNode);
        if ('missing' in resolved) {
          const reason = `${REVO_INPUT_MISSING}: required input ${resolved.missing} was not produced`;
          await appendEvent({
            runId, taskId, stepId: '', stepKey: stepKeyFor(node.id, ordinal), type: 'step_failed',
            payload: { nodeId: node.id, error: reason },
          });
          return { lastResult: { outcome: 'failed', errorCode: REVO_INPUT_MISSING }, lastVerdict: 'failed', failureReason: reason, stepDelta: 1 };
        }
        const scriptResult = await invokeScript(runId, decision, { taskId, title, base, issueRef: ctx.issueRef, issueAction: ctx.issueAction }, bindingByNode, ctx.scriptBindings, stepKeyFor(node.id, ordinal), resolved.inputs);
        if (scriptResult.outcome === 'blocked') {
          const recoveryContext = scriptResult.pointer === undefined
            ? undefined
            : await recordRecoveryContext(runId, node, ordinal, stepKeyFor(node.id, ordinal), scriptResult.pointer, ctx.outputsByNode);
          return {
            lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_BLOCKED },
            lastVerdict: 'blocked',
            ...(recoveryContext ? { recoveryContext } : {}),
            stepDelta: 1,
          };
        }
        if (scriptResult.outcome === 'failed') {
          const reason = scriptResult.reason ? `${REVO_SCRIPT_FAILED}: ${scriptResult.reason}` : REVO_SCRIPT_FAILED;
          return { lastResult: { outcome: 'failed', errorCode: REVO_SCRIPT_FAILED }, lastVerdict: 'failed', recoveryContext: null, failureReason: reason, stepDelta: 1 };
        }
        let pointer = scriptResult.pointer;
        let sv = scriptResult.verdict;
        let stateOverride: RunState | undefined;
        const headMove = approvedHeadMove(decision, ctx.approvedMergeGateHeadSha, pointer, sv);
        if (headMove) {
          pointer = reapprovalRequiredFeedback(pointer, headMove.approvedHeadSha, headMove.reverifyHeadSha);
          sv = 'recheck';
          stateOverride = reopenNodeState(ctx.state, 'mergeGate');
        }
        const producedOutput = await recordOutput(runId, node, ordinal, stepKeyFor(node.id, ordinal), pointer, ctx.outputsByNode);
        return {
          lastResult: stateOverride ? undefined : { outcome: 'succeeded', ...(sv ? { verdict: sv } : {}) },
          ...(sv ? { lastVerdict: sv } : {}),
          ...(producedOutput ? { producedOutput } : {}),
          ...(ctx.recoveryContext ? { recoveryContext: recoveryContextAfterNode(node.id, ctx.recoveryContext) } : {}),
          ...(stateOverride ? { stateOverride } : {}),
          stepDelta: 1,
        };
      }
      case 'awaitGate': {
        const topic = gateTopicFor(decision.reason);
        const ordinal = nextOrdinal(ctx.effectOrdinalByNode, decision.nodeId);
        const summary = buildGateSummary(decision, ctx.outputsByNode, ctx.lastVerdict, ctx.lastProducedOutput, ctx.recoveryContext);
        const human = await awaitHuman(
          runId,
          topic,
          stepKeyFor(decision.nodeId, ordinal),
          `${decision.reason} approval`,
          summary,
          decision.outcomes,
        );
        const verdict = gateVerdict(human, decision.outcomes);
        const approvedHeadSha = approvedMergeGateHeadSha(decision, verdict, summary);
        const producedOutput = await recordOutput(
          runId,
          resolveNode(template, decision.nodeId),
          ordinal,
          stepKeyFor(decision.nodeId, ordinal),
          gateResolutionOutput(human, verdict, stepKeyFor(decision.nodeId, ordinal), approvedHeadSha),
          ctx.outputsByNode,
        );
        return {
          lastResult: verdict ? { verdict } : {},
          ...(verdict ? { lastVerdict: verdict } : {}),
          ...(producedOutput ? { producedOutput } : {}),
          ...(decision.nodeId === 'recoveryGate' ? { recoveryContext: null } : {}),
          ...(approvedHeadSha !== undefined ? { approvedMergeGateHeadSha: approvedHeadSha } : {}),
          stepDelta: 0,
        };
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

  async function awaitTransientRetryGate(
    runId: string,
    ctx: EffectCtx,
    input: {
      node: Node;
      stepKey: string;
      binding: ResolvedAgentBinding;
      retry: RunnerRetryBlockPayload;
    },
  ): Promise<TransientRetryGateOutcome> {
    const outcomes = [...TRANSIENT_RETRY_GATE_OUTCOMES];
    const decision = await awaitHuman(
      runId,
      'retry',
      `transientRetry:${input.stepKey}`,
      `Retry ${input.node.id} after transient runner failure`,
      {
        kind: 'transient_retry',
        runId,
        taskId: ctx.taskId,
        nodeId: input.node.id,
        step: input.stepKey,
        role: input.binding.roleId,
        runner: input.binding.runner.runnerId,
        reason: input.retry.reason,
        lesson: input.retry.lesson,
        attemptsExhausted: input.retry.attemptsExhausted,
        attemptsMade: input.retry.attemptsMade,
        maxAttempts: input.retry.maxAttempts,
        attemptIds: input.retry.attemptIds,
        lastAttemptId: input.retry.lastAttemptId,
        ...(input.retry.failureKind ? { failureKind: input.retry.failureKind } : {}),
        ...(input.retry.transientKind ? { transientKind: input.retry.transientKind } : {}),
        ...(input.retry.timing !== undefined ? { timing: input.retry.timing } : {}),
        reconcile: { default: 'keep', supported: ['keep'] },
        outcomes,
      },
      outcomes,
    );
    return transientRetryGateOutcome(decision);
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
    return invokeRoleAttempts({
      runId,
      decision,
      node,
      ctx,
      inputs,
      stepKey,
      binding,
      retryContext: ctx.agentQuestionRetryContextByNode.get(node.id),
    });
  }

  function resolveRoleBinding(
    ctx: EffectCtx,
    decision: Extract<Decision, { type: 'invokeRole' }>,
  ): ResolvedAgentBinding {
    return resolvePinnedAgentBinding(ctx.bindingByNode, decision.nodeId);
  }

  async function invokeRoleAttempts(input: InvokeRoleAttemptInput): Promise<InvokeRoleResult> {
    const { runId, decision, node, ctx, inputs, stepKey, binding } = input;
    const attemptIds: string[] = [];
    const retryContext = input.retryContext;

    for (let attemptNo = 1; attemptNo <= ctx.runnerRetryPolicy.maxAttempts; attemptNo++) {
      const physicalAttempt = physicalAttemptFor(runId, stepKey, attemptNo);
      attemptIds.push(physicalAttempt.attemptId);
      const result = await runStepFn(
        runId,
        binding.roleId,
        stepKey,
        stepInputForAttempt(decision.nodeId, inputs, physicalAttempt, retryContext),
        binding,
        physicalAttempt,
        ctx.template.verdicts.domain,
      );

      const needsHuman = await maybeHandleNeedsHumanRoleResult({
        ...input,
        attemptIds,
        physicalAttempt,
        result,
      });
      if (needsHuman) {
        if ('action' in needsHuman) {
          continue;
        }
        return needsHuman;
      }

      const failed = roleValidationFailure(ctx.template, node, result, physicalAttempt);
      if (failed) return failed;

      let output = result.output;
      const hasProducedChange = producedChangeArtifact(output) !== undefined;
      const shouldCaptureChange =
        nodeProducesChange(node) &&
        !hasProducedChange &&
        ctx.live &&
        binding.runner.capabilities.worktreeChanges === true;
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
          ...(ctx.issueAction ? { issueAction: ctx.issueAction } : {}),
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
    const { result, node, physicalAttempt, binding, stepKey } = input;
    if (result.needsHuman) {
      const safeLesson = String(redactEventPayload(result.lesson ?? `agent ${node.id} reported needsHuman`));
      const recoveryBlock = verificationEnvironmentBlock(result, node.id);
      if (recoveryBlock) {
        return {
          blocked: true,
          reason: recoveryBlock.reason,
          lesson: recoveryBlock.lesson,
          recovery: {
            classification: 'verification_environment',
            nodeId: node.id,
            stepKey,
            role: binding.roleId,
            runner: binding.runner.runnerId,
            reason: recoveryBlock.reason,
            lesson: recoveryBlock.lesson,
            attemptId: physicalAttempt.attemptId,
            ...(artifactRefFromResult(result) ? { artifactRef: artifactRefFromResult(result) } : {}),
          },
          attemptsMade: physicalAttempt.attemptNo,
        };
      }
      const transient = transientRunnerFailure(result);
      if (transient === undefined) {
        const question = await awaitAgentQuestion({ ...input, safeLesson, physicalAttempt });
        if ('unresolved' in question) {
          return {
            blocked: true,
            reason: question.reason,
            lesson: question.lesson,
            attemptsMade: physicalAttempt.attemptNo,
          };
        }
        return { question: true, retryContext: question, attemptsMade: physicalAttempt.attemptNo };
      }
      return handleTransientRoleResult({ ...input, transient });
    }

    return undefined;
  }

  async function awaitAgentQuestion(
    input: InvokeRoleAttemptInput & {
      physicalAttempt: PhysicalRunStepAttempt;
      safeLesson: string;
    },
  ): Promise<AgentQuestionRetryContext | UnresolvedAgentQuestion> {
    const { runId, node, ctx, stepKey, binding, physicalAttempt, safeLesson } = input;
    const question = await awaitHuman(
      runId,
      'question',
      `agentQuestion:${stepKey}:attempt${physicalAttempt.attemptNo}`,
      `${node.id} question`,
      {
        kind: 'agent_question',
        runId,
        taskId: ctx.taskId,
        nodeId: node.id,
        step: stepKey,
        role: binding.roleId,
        runner: binding.runner.runnerId,
        lesson: safeLesson,
        attemptId: physicalAttempt.attemptId,
      },
      undefined,
      'question',
    );
    const retryContext = agentQuestionRetryContext(question, node.id, safeLesson);
    if (retryContext === undefined) {
      return {
        unresolved: true,
        reason: 'agent-question-unresolved',
        lesson: unresolvedAgentQuestionLesson(node.id, safeLesson, question),
      };
    }
    await appendEvent({
      runId,
      taskId: ctx.taskId,
      stepId: '',
      stepKey,
      type: 'agent_question_resolved',
      idempotencyKey: `${physicalAttempt.attemptId}:question`,
      payload: {
        nodeId: node.id,
        inboxId: retryContext.inboxId,
        resolvedBy: retryContext.resolvedBy,
      },
    });
    return retryContext;
  }

  async function handleTransientRoleResult(
    input: InvokeRoleAttemptInput & {
      attemptIds: string[];
      physicalAttempt: PhysicalRunStepAttempt;
      transient: TransientRunnerFailure;
    },
  ): Promise<RetryRoleResult | InvokeRoleBlockedResult> {
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
      return { action: 'retry' };
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

  async function awaitVerificationRecoveryGate(
    runId: string,
    ctx: EffectCtx,
    recovery: VerificationEnvironmentRecovery,
  ): Promise<{ reason: string; lesson: string }> {
    const outcomes = ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort'];
    const decision = await awaitHuman(
      runId,
      'question',
      `verificationRecovery:${recovery.stepKey}`,
      'Verification blocked by local environment',
      {
        topic: 'verification_recovery',
        runId,
        taskId: ctx.taskId,
        nodeId: recovery.nodeId,
        step: recovery.stepKey,
        role: recovery.role,
        runner: recovery.runner,
        verdict: 'verification-blocked',
        reason: recovery.reason,
        lesson: recovery.lesson,
        attemptId: recovery.attemptId,
        ...(recovery.artifactRef ? { artifactRef: recovery.artifactRef } : {}),
        policy:
          'Revo-owned role work remains owned by Revo. The main session may inspect artifacts but must not apply, copy, cherry-pick, stage, commit, or push Revo worktree changes unless this gate is resolved with adopt_patch_manually and a complete adoptionAudit.',
        outcomes,
      },
      outcomes,
    );
    const outcome = decision.outcome ?? (decision.decision === 'approve' ? 'continue_in_revo' : 'abort');
    if (outcome === 'abort') {
      return { reason: 'verification-recovery-aborted', lesson: recovery.lesson };
    }
    return {
      reason: `verification-recovery-decision:${outcome}`,
      lesson: `Human selected ${outcome}; recovery is recorded but no Revo worktree patch was adopted by the main session.`,
    };
  }












  async function invokeScript(
    runId: string,
    decision: Extract<Decision, { type: 'invokeScript' }>,
    ctx: { taskId: string; title: string; base: string; issueRef?: IssueRef; issueAction?: IssueAction },
    bindingByNode: Map<string, ResolvedAgentBinding>,
    scriptBindings: ResolvedScriptBinding[],
    stepKey: string,
    inputs: Record<string, unknown>,
  ): Promise<ScriptResult> {
    const handler = scriptRegistry.get(decision.scriptRef);
    if (!handler) {
      const reason = `script handler is not registered: ${decision.scriptRef}`;
      await appendEvent({
        runId,
        taskId: ctx.taskId,
        stepId: '',
        stepKey,
        type: 'step_failed',
        payload: { scriptRef: decision.scriptRef, error: reason },
      });
      return { outcome: 'failed', reason };
    }
    return handler({ runId, decision, ctx, bindingByNode, scriptBindings, stepKey, inputs });
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
    } else if (status === 'cancelled') {
      await appendEvent({
        runId,
        taskId: '',
        stepId: '',
        stepKey: 'pipeline',
        type: 'pipeline_cancelled',
        payload: { reason: 'route-terminal', lastVerdict: verdict, steps },
      });
      await cancelRun(runId, { actor: 'pipeline', source: 'data-driven-cancelled' });
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
