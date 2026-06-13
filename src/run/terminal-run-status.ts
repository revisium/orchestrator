/**
 * terminal-run-status.ts — shared event-first terminal-status writer for a run.
 *
 * cancel-run.ts (run_cancelled → status 'cancelled'), fail-run.ts (run_failed → status 'failed'),
 * and complete-run.ts (run_completed → status 'completed') are structurally identical: read the run,
 * no-op if already in the terminal status, else write the terminal event FIRST (deterministic id,
 * ROW_CONFLICT-idempotent) then patch task_runs.status. This one helper holds that logic ONCE
 * (DRY — removes the cross-file duplication Sonar flags on new code).
 *
 * EVENT-FIRST + deterministic id + ROW_CONFLICT no-op give replay safety (0004 CR-A): on a workflow
 * replay the event id re-derives, createRow hits ROW_CONFLICT, and the status patch is still applied
 * idempotently. `previous_status` is captured on the FIRST execution and preserved across replays.
 */
import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

export type TerminalRunStatus = 'cancelled' | 'failed' | 'completed';

export type RecordTerminalParams = {
  /** Terminal status to set on task_runs. */
  status: TerminalRunStatus;
  /** Event type written to the events table (e.g. 'run_cancelled' / 'run_failed'). */
  eventType: string;
  /** Event actor (e.g. 'cli' / 'pipeline'). */
  actor: string;
  /** Extra event payload fields; `previous_status` is merged in automatically. */
  payload: Record<string, unknown>;
  /** Wall clock (injectable for tests). */
  now: Date;
};

/**
 * recordTerminalRunStatus — write `<eventType>` event (event-first) + patch task_runs to `status`.
 * Returns `{ previousStatus }`, or null when the run does not exist. Idempotent + replay-safe.
 * When the run is ALREADY in the terminal status, this is a no-op (the first event preserved its
 * true previous_status; no fresh updated_at on replay).
 */
export async function recordTerminalRunStatus(
  da: ControlPlaneDataAccess,
  runId: string,
  params: RecordTerminalParams,
): Promise<{ previousStatus: string } | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const prev = typeof row.data.status === 'string' ? row.data.status : '';
  if (prev === params.status) {
    return { previousStatus: prev };
  }

  const nowIso = params.now.toISOString();
  const statusPatch = [
    { op: 'replace' as const, path: 'status', value: params.status },
    { op: 'replace' as const, path: 'updated_at', value: nowIso },
  ];
  const eventId = `event_${fnv1a64Hex(`${runId}|${params.eventType}`)}`;

  try {
    await da.createRow('events', eventId, {
      id: eventId,
      run_id: runId,
      type: params.eventType,
      payload: { ...params.payload, previous_status: prev },
      actor: params.actor,
      created_at: nowIso,
    });
  } catch (e) {
    // Replay: event already written (true prior status preserved) → still apply the status patch.
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') {
      await da.patchRow('task_runs', runId, statusPatch);
      return { previousStatus: prev };
    }
    throw e;
  }

  await da.patchRow('task_runs', runId, statusPatch);
  return { previousStatus: prev };
}
