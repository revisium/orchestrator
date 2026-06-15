/**
 * block-run.ts - patch task_runs to `paused` + write a run_blocked event.
 *
 * A pipeline can stop cleanly with `blocked: true` while DBOS reports workflow SUCCESS.
 * Without this verb, the Revisium run row stays `ready`, making the control-plane state
 * claim work is still claimable even though the workflow intentionally stopped.
 */
import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

export type BlockRunResult = {
  runId: string;
  previousStatus: string;
  status: 'paused';
};

export async function blockRun(
  da: ControlPlaneDataAccess,
  runId: string,
  opts?: { now?: Date; actor?: string; source?: string; reason?: string },
): Promise<BlockRunResult | null> {
  const result = await recordTerminalRunStatus(da, runId, {
    status: 'paused',
    eventType: 'run_blocked',
    actor: opts?.actor ?? 'pipeline',
    payload: {
      source: opts?.source ?? 'pipeline-blocked',
      reason: opts?.reason ?? '',
    },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'paused' };
}
