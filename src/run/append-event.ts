/**
 * appendRunEvent / appendRunCost — idempotent meaning writes to the Revisium DRAFT.
 *
 * Design rules (from architecture-overview + TASK 0003):
 *   - Events go to DRAFT, never committed (high-frequency runtime data).
 *   - Row ids are DETERMINISTIC and BOUNDED via fnv1a64Hex (not crypto, no weak-hash hotspot).
 *     event id = "event_" + 16 hex = 22 chars (<64 Revisium limit).
 *     cost  id = "cost_"  + 16 hex = 21 chars (<64 Revisium limit).
 *   - Idempotent: a DBOS replay that re-runs the step body re-derives the same id;
 *     createRow throws ROW_CONFLICT (ControlPlaneError code:'ROW_CONFLICT') which we catch
 *     and skip — exactly the pattern createSteps uses (steps.ts:351).
 */
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
  /**
   * Optional physical-effect scope for event types that can repeat for the same logical stepKey
   * (for example retry attempts). Omitted legacy callers keep the historic `(runId,stepKey,type)` key.
   */
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

/**
 * Deep-redact GitHub token shapes from every string leaf of an event payload before it is persisted
 * to the Revisium draft. The attempts row redacts `lesson`/`error` explicitly (appendRunAttempt); an
 * event payload carries the same free text (e.g. an integrator `pipeline_blocked` lesson) and must
 * not leak a raw token. Redacting at this persist boundary covers every payload field, including ones
 * added by future event types.
 */
export function redactEventPayload(value: unknown): unknown {
  if (typeof value === 'string') return redactTokens(value);
  if (Array.isArray(value)) return value.map(redactEventPayload);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEventPayload(v)]));
  }
  return value;
}

/**
 * Write a single event row to the `events` table.
 *
 * eventId = `event_${fnv1a64Hex(`${runId}|${stepKey}|${type}|${idempotencyKey}`)}` → 22 chars ≤ 64
 *
 * Idempotent: catches ROW_CONFLICT and returns (no-op on replay).
 */
export async function appendRunEvent(
  da: ControlPlaneDataAccess,
  input: AppendEventInput,
): Promise<void> {
  const { runId, taskId, stepId, stepKey, type, payload, idempotencyKey, actor, createdAt } = input;
  const idempotencyScope = idempotencyKey ? `|${idempotencyKey}` : '';
  const eventId = `event_${fnv1a64Hex(`${runId}|${stepKey}|${type}${idempotencyScope}`)}`;
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
  /** Deterministic attempt id minted by the step (e.g. `attempt_<hash>`); used as the row id. */
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
  /** Raw agent output — secret-redacted + capped here before persisting (never raw). */
  output: unknown;
  lesson?: string;
  error?: string;
  artifactRef?: string;
  stdoutTail?: string;
  stderrTail?: string;
  startedAt?: Date;
  finishedAt?: Date;
};

/** Cap the serialized output summary so a giant agent payload can't bloat the attempts row. */
const OUTPUT_SUMMARY_MAX = 4_000;

/**
 * Write a single per-attempt observability row to the `attempts` table (0008 #4).
 *
 * Populates the previously-unused `attempts` table so `revo run log` can show output summary,
 * verdict, model, tokens, cost, duration, and iteration per attempt — the dogfood's observability
 * gap (agent output was only recoverable indirectly via plan files / commit diffs).
 *
 * SECRET BOUNDARY: the output summary, lesson, and error are secret-redacted (object keys via
 * redactSecrets, token shapes via redactTokens) before persisting — attempts live in Revisium.
 *
 * Idempotent: the row id IS the deterministic attemptId; ROW_CONFLICT is a no-op on replay.
 */
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

/**
 * Write a single cost row to the `cost_ledger` table.
 *
 * costId = `cost_${fnv1a64Hex(`${runId}|${stepKey}|${attemptId}|${index}`)}` → 21 chars ≤ 64
 *
 * Idempotent: catches ROW_CONFLICT and returns (no-op on replay).
 */
export async function appendRunCost(
  da: ControlPlaneDataAccess,
  input: AppendCostInput,
): Promise<void> {
  const { runId, stepId, stepKey, attemptId, cost, index, recordedAt } = input;
  const costId = `cost_${fnv1a64Hex(`${runId}|${stepKey}|${attemptId}|${index}`)}`;
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
