import { randomUUID } from 'node:crypto';
import {
  claimNextStep,
  startAttempt,
  writeResult,
  createSteps,
  failStep,
  recoverInFlight,
  compactStamp,
  type Step,
  type NewStep,
} from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { RunAgent, AttemptResult } from './runner.js';
import { buildContext } from './build-context.js';

async function processClaimedStep(
  deps: WorkerDeps,
  workerId: string,
  step: Step,
): Promise<{ attemptId: string; result: AttemptResult } | null> {
  const { da, loadRole, loadModelProfile, runAgent } = deps;
  const role = await loadRole(step.role);
  const profile = await loadModelProfile(role.modelLevel);
  const context = await buildContext(da, step, role);
  const { attemptId } = await startAttempt(da, step, { workerId, modelProfile: profile.modelId });
  try {
    const result = await runAgent({ role, profile, context, attemptId, step });
    return { attemptId, result };
  } catch (err) {
    await failStep(da, step, attemptId, {
      lesson: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return null;
  }
}

async function handleResult(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  result: AttemptResult,
): Promise<void> {
  if (result.needsHuman) {
    await parkForHuman(da, step, attemptId, result);
    return;
  }
  const nextSteps: NewStep[] = result.nextSteps.map((ns) => ({ ...ns, runId: step.runId }));
  // createSteps runs BEFORE writeResult makes the parent terminal. Child IDs are a bounded,
  // deterministic hash of (parent id + index), so a retry regenerates the same IDs and
  // createSteps' idempotency check skips existing rows.
  //
  // createSteps failures (e.g. Revisium rejecting an invalid next step) are pre-terminal and
  // SAFE to fail gracefully: nothing has been finalized yet, so failStep lets the step back off
  // / go dead instead of crashing the worker. writeResult is DIFFERENT — it mutates several rows
  // (attempt close, event, cost, then the step), so a partial failure must NOT be routed through
  // failStep (that would mark a half-written step failed). We let writeResult errors propagate:
  // the step stays 'running' → recoverInFlight resets it on the next start → idempotent retry.
  try {
    await createSteps(da, nextSteps, { parentStepId: step.id });
  } catch (err) {
    await failStep(da, step, attemptId, {
      lesson: err instanceof Error ? err.message : String(err),
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    return;
  }
  await writeResult(da, step, attemptId, result.output, result.costs);
}

export type WorkerDeps = {
  da: ControlPlaneDataAccess;
  loadRole: (name: string) => Promise<Role>;
  loadModelProfile: (level: string) => Promise<ModelProfile>;
  runAgent: RunAgent;
};

export type WorkerOptions = {
  workerId: string;
  roles: string[];
  once?: boolean;
  idleSleepMs?: number;
  maxCycles?: number;
  signal?: AbortSignal;
};

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function parkForHuman(
  da: ControlPlaneDataAccess,
  step: Step,
  attemptId: string,
  result: AttemptResult,
): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const st = compactStamp(now);
  const sfx = randomUUID().replaceAll('-', '').slice(0, 8);

  // Close the attempt so it is no longer 'running' while the step waits for a human.
  await da.patchRow('attempts', attemptId, [
    { op: 'replace', path: 'status', value: 'paused' },
    { op: 'replace', path: 'finished_at', value: nowIso },
  ]);

  // Minimal inbox parking: mark step awaiting_approval, clear lease, append event.
  // Full pushInbox (inbox row creation + resolution workflow) is deferred.
  await da.patchRow('steps', step.id, [
    { op: 'replace', path: 'status', value: 'awaiting_approval' },
    { op: 'replace', path: 'lease_owner', value: '' },
    { op: 'replace', path: 'lease_expires_at', value: '' },
    { op: 'replace', path: 'updated_at', value: nowIso },
  ]);
  await da.createRow('events', `event_${st}_step-needs-human_${sfx}`, {
    id: `event_${st}_step-needs-human_${sfx}`,
    run_id: step.runId,
    task_id: step.taskId,
    step_id: step.id,
    type: 'step_needs_human',
    payload: { attempt_id: attemptId, lesson: result.lesson },
    actor: 'orchestrator',
    created_at: nowIso,
  });
}

type StepOutcome = 'completed' | 'idle' | 'failed';

async function runNextStep(deps: WorkerDeps, workerId: string, roles: string[]): Promise<StepOutcome> {
  const { da } = deps;
  const step = await claimNextStep(da, workerId, roles);
  if (!step) return 'idle';
  const processed = await processClaimedStep(deps, workerId, step);
  if (!processed) return 'failed';
  await handleResult(da, step, processed.attemptId, processed.result);
  return 'completed';
}

export async function runWorker(deps: WorkerDeps, opts: WorkerOptions): Promise<void> {
  const { da } = deps;
  const { workerId, roles, once, idleSleepMs = 5000, maxCycles, signal } = opts;

  if (!Number.isFinite(idleSleepMs) || idleSleepMs < 0) {
    throw new Error(`idleSleepMs must be a non-negative finite number, got: ${String(idleSleepMs)}`);
  }

  await recoverInFlight(da, workerId);

  let cycles = 0;

  while (true) {
    if (signal?.aborted) break;
    if (maxCycles !== undefined && cycles >= maxCycles) break;
    const outcome = await runNextStep(deps, workerId, roles);
    if (outcome !== 'idle') cycles++;
    if (once) break;
    if (outcome === 'idle') await sleep(idleSleepMs, signal);
  }
}
