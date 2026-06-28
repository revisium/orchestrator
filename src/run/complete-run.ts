




import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

export type CompleteRunResult = {
  runId: string;
  previousStatus: string;
  status: 'completed';
};

export async function completeRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; actor?: string; source?: string; verdict?: string; iterations?: number },
): Promise<CompleteRunResult | null> {
  const result = await recordTerminalRunStatus(da, runId, {
    status: 'completed',
    eventType: 'run_completed',
    actor: opts?.actor ?? 'pipeline',
    payload: {
      source: opts?.source ?? 'workflow-complete',
      verdict: opts?.verdict ?? '',
      iterations: opts?.iterations ?? 0,
    },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'completed' };
}
