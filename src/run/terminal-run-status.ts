/**
 * terminal-run-status.ts — shared event-first terminal-status writer for a run.
 *
 * cancel-run.ts (run_cancelled → status 'cancelled'), fail-run.ts (run_failed → status 'failed'),
 * and complete-run.ts (run_completed → status 'completed') are structurally identical: read the run,
 * write the terminal event FIRST (deterministic id, ROW_CONFLICT-idempotent) then patch
 * task_runs.status. This one helper holds that logic ONCE
 * (DRY — removes the cross-file duplication Sonar flags on new code).
 *
 * EVENT-FIRST + deterministic id + ROW_CONFLICT no-op give replay safety (0004 CR-A): on a workflow
 * replay the event id re-derives, createRow hits ROW_CONFLICT, and the status patch is still applied
 * idempotently. `previous_status` is captured on the FIRST execution and preserved across replays.
 */
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions } from '../control-plane/index.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

const RELATED_ROW_PAGE_SIZE = 500;
const RELATED_ROW_PATCH_CONCURRENCY = 20;

export type TerminalRunStatus = 'cancelled' | 'failed' | 'completed';
type TerminalStepStatus = 'skipped' | 'failed' | 'succeeded';
const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'skipped', 'dead']);

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

function terminalStepStatusForRunStatus(status: TerminalRunStatus): TerminalStepStatus {
  if (status === 'completed') return 'succeeded';
  if (status === 'failed') return 'failed';
  // A cancelled run stops remaining work without claiming execution failure.
  return 'skipped';
}

function isTerminalStepStatus(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL_STEP_STATUSES.has(status);
}

// Prisma path+equals accepts scalar values; the SDK types equals as an object due to generated types.
function runIdWhere(runId: string): ListRowsOptions['where'] {
  return { data: { path: 'run_id', equals: runId as unknown as Record<string, unknown> } };
}

async function runBounded<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(workers);
}

/**
 * recordTerminalRunStatus — write `<eventType>` event (event-first) + patch task_runs to `status`.
 * Returns `{ previousStatus }`, or null when the run does not exist. Idempotent + replay-safe.
 * When the run is ALREADY in the terminal status, the run row and event are left alone (the first
 * event preserved its true previous_status; no fresh updated_at on the run row), but related
 * task/step rows are still reconciled. That keeps retries safe if an earlier attempt patched the
 * run row and crashed before propagation finished.
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
  const nowIso = params.now.toISOString();
  const statusPatch = [
    { op: 'replace' as const, path: 'status', value: params.status },
    { op: 'replace' as const, path: 'updated_at', value: nowIso },
  ];
  const taskPatch = [
    { op: 'replace' as const, path: 'status', value: params.status },
    { op: 'replace' as const, path: 'updated_at', value: nowIso },
  ];
  const stepStatus = terminalStepStatusForRunStatus(params.status);
  const stepPatch = [
    { op: 'replace' as const, path: 'status', value: stepStatus },
    { op: 'replace' as const, path: 'updated_at', value: nowIso },
  ];
  const eventId = `event_${fnv1a64Hex(`${runId}|${params.eventType}`)}`;

  async function listRowsForRun(table: 'tasks' | 'steps') {
    const rows: ControlPlaneRow[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await da.listRows(table, {
        first: RELATED_ROW_PAGE_SIZE,
        after,
        where: runIdWhere(runId),
      });
      rows.push(...page);
      if (page.length < RELATED_ROW_PAGE_SIZE) break;
      after = page.at(-1)?.cursor;
      if (!after) break;
    }
    return rows;
  }

  async function patchRelatedTerminalRows(): Promise<void> {
    const [tasks, steps] = await Promise.all([
      listRowsForRun('tasks'),
      listRowsForRun('steps'),
    ]);
    const patches: Array<{
      table: 'tasks' | 'steps';
      rowId: string;
      patch: typeof taskPatch | typeof stepPatch;
    }> = [
      ...tasks
        .filter((task) => task.data.run_id === runId && task.data.status !== params.status)
        .map((task) => ({ table: 'tasks' as const, rowId: task.rowId, patch: taskPatch })),
      ...steps
        .filter((step) => step.data.run_id === runId && !isTerminalStepStatus(step.data.status) && step.data.status !== stepStatus)
        .map((step) => ({ table: 'steps' as const, rowId: step.rowId, patch: stepPatch })),
    ];
    await runBounded(patches, RELATED_ROW_PATCH_CONCURRENCY, async (patch) => {
      await da.patchRow(patch.table, patch.rowId, patch.patch);
    });
  }

  async function patchTerminalRows(): Promise<void> {
    await da.patchRow('task_runs', runId, statusPatch);
    await patchRelatedTerminalRows();
  }

  if (prev === params.status) {
    await patchRelatedTerminalRows();
    return { previousStatus: prev };
  }

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
      await patchTerminalRows();
      return { previousStatus: prev };
    }
    throw e;
  }

  await patchTerminalRows();
  return { previousStatus: prev };
}
