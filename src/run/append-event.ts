









import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { redactSecrets } from '../control-plane/inbox.js';
import { redactTokens } from '../runners/gh-identity.js';

export type AppendEventInput = {
  runId: string;
  taskId: string;
  stepId: string;
  stepKey: string;
  type: string;
  payload: unknown;


  idempotencyKey?: string;
  actor?: string;
  createdAt?: Date;
};

export type AppendCostInput = {
  runId: string;
  stepId: string;
  stepKey: string;
  attemptId: string;
  cost: {
    modelProfile: string;
    inputTokens: number;
    outputTokens: number;
    costAmount: number;
    currency?: string;
  };
  index: number;
  recordedAt?: Date;
};






export function redactEventPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactTokens(value);
  if (Array.isArray(value)) return value.map(redactEventPayload);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEventPayload(v)]));
  }
  return value;
}






export async function appendRunEvent(
  da: ControlPlaneDataAccess,
  input: AppendEventInput,
): Promise<void> {
  const { runId, taskId, stepId, stepKey, type, payload, idempotencyKey, actor, createdAt } = input;
  const idempotencyScope = idempotencyKey ? `|${idempotencyKey}` : '';
  const eventKey = `${runId}|${stepKey}|${type}${idempotencyScope}`;
  const eventId = `event_${fnv1a64Hex(eventKey)}`;
  const createdAtIso = (createdAt ?? new Date()).toISOString();
  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      task_id: taskId,
      step_id: stepId,
      type,
      payload: redactEventPayload(payload),
      actor: actor ?? 'orchestrator',
      created_at: createdAtIso,
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return;
    throw e;
  }
}

export type AppendAttemptInput = {
  runId: string;
  stepId: string;

  attemptId: string;
  attemptNo: number;
  iteration: number;
  status: string;
  modelProfile: string;
  verdict: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  currency?: string;
  durationMs: number;

  output: unknown;
  lesson?: string;
  error?: string;
  artifactRef?: string;
  stdoutTail?: string;
  stderrTail?: string;
  startedAt?: Date;
  finishedAt?: Date;
};


const OUTPUT_SUMMARY_MAX = 4_000;











export async function appendRunAttempt(
  da: ControlPlaneDataAccess,
  input: AppendAttemptInput,
): Promise<void> {
  const summaryRaw = JSON.stringify(redactSecrets(input.output) ?? null);
  const outputSummary = redactTokens(summaryRaw).slice(0, OUTPUT_SUMMARY_MAX);
  const artifactRef = input.artifactRef ? redactTokens(input.artifactRef).slice(0, OUTPUT_SUMMARY_MAX) : '';
  const stdoutTail = input.stdoutTail ? redactTokens(input.stdoutTail).slice(0, OUTPUT_SUMMARY_MAX) : '';
  const stderrTail = input.stderrTail ? redactTokens(input.stderrTail).slice(0, OUTPUT_SUMMARY_MAX) : '';
  try {
    await da.createRow('attempts', input.attemptId, {
      id: input.attemptId,
      step_id: input.stepId,
      run_id: input.runId,
      worker_id: '',
      attempt_no: input.attemptNo,
      iteration: input.iteration,
      status: input.status,
      idempotency_key: input.attemptId,
      model_profile: input.modelProfile,
      verdict: input.verdict,
      input_tokens: input.inputTokens,
      output_tokens: input.outputTokens,
      cost_amount: input.costAmount,
      currency: input.currency ?? 'USD',
      duration_ms: input.durationMs,
      output_summary: outputSummary,
      artifact_ref: artifactRef,
      stdout_tail: stdoutTail,
      stderr_tail: stderrTail,
      lesson: input.lesson ? redactTokens(input.lesson).slice(0, OUTPUT_SUMMARY_MAX) : '',
      error: input.error ? redactTokens(input.error).slice(0, OUTPUT_SUMMARY_MAX) : '',
      started_at: (input.startedAt ?? new Date()).toISOString(),
      finished_at: (input.finishedAt ?? new Date()).toISOString(),
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return;
    throw e;
  }
}






export async function appendRunCost(
  da: ControlPlaneDataAccess,
  input: AppendCostInput,
): Promise<void> {
  const { runId, stepId, stepKey, attemptId, cost, index, recordedAt } = input;
  const costKey = `${runId}|${stepKey}|${attemptId}|${index}`;
  const costId = `cost_${fnv1a64Hex(costKey)}`;
  const recordedAtIso = (recordedAt ?? new Date()).toISOString();
  try {
    await da.createRow('cost_ledger', costId, {
      id: costId,
      run_id: runId,
      step_id: stepId,
      attempt_id: attemptId,
      model_profile: cost.modelProfile,
      input_tokens: cost.inputTokens,
      output_tokens: cost.outputTokens,
      cost_amount: cost.costAmount,
      currency: cost.currency ?? 'USD',
      recorded_at: recordedAtIso,
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return;
    throw e;
  }
}
