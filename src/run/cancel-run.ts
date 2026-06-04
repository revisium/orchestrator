import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { compactStamp } from '../control-plane/steps.js';

export type CancelRunResult = {
  runId: string;
  previousStatus: string;
  status: 'cancelled';
};

export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; idSuffix?: string },
): Promise<CancelRunResult | null> {
  await da.assertReady();

  const row = await da.getRow('task_runs', runId);
  if (!row) return null;

  const previousStatus = typeof row.data.status === 'string' ? row.data.status : '';
  const now = opts?.now ?? new Date();
  const nowIso = now.toISOString();

  await da.patchRow('task_runs', runId, [
    { op: 'replace', path: 'status', value: 'cancelled' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);

  const rawSuffix = opts?.idSuffix;
  const suffix = rawSuffix && rawSuffix.length > 0 ? rawSuffix : randomUUID().replaceAll('-', '').slice(0, 8);
  const eventId = `event_${compactStamp(now)}_run-cancelled_${suffix}`;
  await da.createRow('events', eventId, {
    id: eventId,
    run_id: runId,
    type: 'run_cancelled',
    payload: { source: 'revo run cancel', previous_status: previousStatus },
    actor: 'cli',
    created_at: nowIso,
  });

  return { runId, previousStatus, status: 'cancelled' };
}
