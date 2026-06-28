













import type { ControlPlaneDataAccess } from '../control-plane/index.js';
import { redactTokens } from '../runners/gh-identity.js';
import { recordTerminalRunStatus } from './terminal-run-status.js';

export type FailRunResult = {
  runId: string;
  previousStatus: string;
  status: 'failed';
};


const REASON_MAX = 2_000;

export async function failRun(
  da: ControlPlaneDataAccess,
  runId: string,
  reason: string,
  opts?: { now?: Date; actor?: string; source?: string },
): Promise<FailRunResult | null> {
  const safeReason = redactTokens(reason).slice(0, REASON_MAX);

  const result = await recordTerminalRunStatus(da, runId, {
    status: 'failed',
    eventType: 'run_failed',
    actor: opts?.actor ?? 'pipeline',
    payload: { source: opts?.source ?? 'workflow-failure', reason: safeReason },
    now: opts?.now ?? new Date(),
  });
  if (!result) return null;
  return { runId, previousStatus: result.previousStatus, status: 'failed' };
}
