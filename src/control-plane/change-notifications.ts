import pg from 'pg';
import { ensureStorage, getActiveStorage } from '../storage/ensure-storage.js';
import type { ControlPlaneRow } from './data-access.js';
import type { RuntimeTable } from './tables.js';

export const CONTROL_PLANE_CHANGE_CHANNEL = 'revo_control_plane_changes';

export type ControlPlaneChangeAction = 'create' | 'update' | 'patch';

export type ControlPlaneChange = {
  table: RuntimeTable;
  action: ControlPlaneChangeAction;
  rowId: string;
  runId?: string;
  row?: ControlPlaneRow;
  rowOmitted?: boolean;
  emittedAt: string;
};

const PG_NOTIFY_PAYLOAD_SOFT_LIMIT_BYTES = 7000;

function rowRunId(
  table: RuntimeTable,
  rowId: string,
  row: ControlPlaneRow,
): string | undefined {
  if (table === 'task_runs') return rowId;
  const candidate = row.data.run_id;
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : undefined;
}

export async function controlPlaneNotificationDatabaseUrl(): Promise<string> {
  return (await ensureStorage()).revoDatabaseUrl;
}

let pool: pg.Pool | null = null;
let poolUrl = '';

function getPool(url: string): pg.Pool {
  if (!pool || poolUrl !== url) {
    pool?.end().catch(() => undefined);
    poolUrl = url;
    pool = new pg.Pool({ connectionString: url, max: 1 });
  }
  return pool;
}

export async function closeControlPlaneNotificationPool(): Promise<void> {
  const current = pool;
  pool = null;
  poolUrl = '';
  await current?.end().catch(() => undefined);
}

export async function notifyControlPlaneChange(
  change: Omit<ControlPlaneChange, 'emittedAt'>,
): Promise<void> {
  const storage = getActiveStorage();
  if (!storage) return;
  try {
    const emittedAt = new Date().toISOString();
    const runId =
      change.runId ??
      (change.row
        ? rowRunId(change.table, change.rowId, change.row)
        : undefined);
    const fullChange = {
      ...change,
      ...(runId ? { runId } : {}),
      emittedAt,
    } satisfies ControlPlaneChange;
    let payload = JSON.stringify(fullChange);
    if (
      Buffer.byteLength(payload, 'utf8') > PG_NOTIFY_PAYLOAD_SOFT_LIMIT_BYTES
    ) {
      payload = JSON.stringify({
        table: change.table,
        action: change.action,
        rowId: change.rowId,
        ...(runId ? { runId } : {}),
        rowOmitted: true,
        emittedAt,
      } satisfies ControlPlaneChange);
    }
    await getPool(storage.revoDatabaseUrl).query('SELECT pg_notify($1, $2)', [
      CONTROL_PLANE_CHANGE_CHANNEL,
      payload,
    ]);
  } catch {}
}
