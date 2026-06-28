











import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions } from '../control-plane/index.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

const RELATED_ROW_PAGE_SIZE = 500;
const RELATED_ROW_PATCH_CONCURRENCY = 20;

export type TerminalRunStatus = 'cancelled' | 'failed' | 'completed' | 'paused';

export type RecordTerminalParams = {

  status: TerminalRunStatus;

  eventType: string;

  actor: string;

  payload: Record<string, unknown>;

  now: Date;
};

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
  const eventId = `event_${fnv1a64Hex(`${runId}|${params.eventType}`)}`;

  async function listRowsForRun(table: 'tasks') {
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
    const tasks = await listRowsForRun('tasks');
    const patches = tasks
      .filter((task) => task.data.run_id === runId && task.data.status !== params.status)
      .map((task) => ({ rowId: task.rowId, patch: taskPatch }));
    await runBounded(patches, RELATED_ROW_PATCH_CONCURRENCY, async (patch) => {
      await da.patchRow('tasks', patch.rowId, patch.patch);
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
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') {
      await patchTerminalRows();
      return { previousStatus: prev };
    }
    throw e;
  }

  await patchTerminalRows();
  return { previousStatus: prev };
}
