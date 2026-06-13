/**
 * complete-run.ts — patch task_runs to `completed` + write a run_completed event.
 *
 * The DBOS workflow can finish successfully while the Revisium run row still says `ready`.
 * This verb mirrors cancel-run.ts/fail-run.ts so Revisium's meaning layer reflects successful
 * terminal workflow progress without weakening replay safety.
 */
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
