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

export type AppendEventInput = {
  runId: string;
  taskId: string;
  stepId: string;
  stepKey: string;
  type: string;
  payload: unknown;
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
 * Write a single event row to the `events` table.
 *
 * eventId = `event_${fnv1a64Hex(`${runId}|${stepKey}|${type}`)}` → 22 chars ≤ 64
 *
 * Idempotent: catches ROW_CONFLICT and returns (no-op on replay).
 */
export async function appendRunEvent(
  da: ControlPlaneDataAccess,
  input: AppendEventInput,
): Promise<void> {
  const { runId, taskId, stepId, stepKey, type, payload, actor, createdAt } = input;
  const eventId = `event_${fnv1a64Hex(`${runId}|${stepKey}|${type}`)}`;
  const createdAtIso = (createdAt ?? new Date()).toISOString();
  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      task_id: taskId,
      step_id: stepId,
      type,
      payload,
      actor: actor ?? 'orchestrator',
      created_at: createdAtIso,
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return;
    throw e;
  }
}

/**
 * Write a single cost row to the `cost_ledger` table.
 *
 * costId = `cost_${fnv1a64Hex(`${runId}|${stepKey}|${index}`)}` → 21 chars ≤ 64
 *
 * Idempotent: catches ROW_CONFLICT and returns (no-op on replay).
 */
export async function appendRunCost(
  da: ControlPlaneDataAccess,
  input: AppendCostInput,
): Promise<void> {
  const { runId, stepId, stepKey, attemptId, cost, index, recordedAt } = input;
  const costId = `cost_${fnv1a64Hex(`${runId}|${stepKey}|${index}`)}`;
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
