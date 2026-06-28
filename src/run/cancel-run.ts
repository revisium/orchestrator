import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

export type CancelRunResult = {
  runId: string;
  previousStatus: string;
  status: 'cancelled';
};





























export async function cancelRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; idSuffix?: string; actor?: string; source?: string },
): Promise<CancelRunResult | null> {
  const result = await recordTerminalRunStatus(da, runId, {
    status: 'cancelled',
    eventType: 'run_cancelled',
    actor: opts?.actor ?? 'cli',
    payload: { source: opts?.source ?? 'revo run cancel' },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'cancelled' };
}
