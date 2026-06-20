import pg from 'pg';
import { isAlive, readRuntime } from '../config.js';
import type { ControlPlaneRow } from './data-access.js';
import type { RuntimeTable } from './tables.js';

export const CONTROL_PLANE_CHANGE_CHANNEL = 'revo_control_plane_changes';

export type ControlPlaneChangeAction = 'create' | 'update' | 'patch';

export type ControlPlaneChange = {
  table: RuntimeTable;
  action: ControlPlaneChangeAction;
  rowId: string;
  row: ControlPlaneRow;
  emittedAt: string;
};

function notificationDatabaseUrl(pgPort: number): string {
  return `postgresql://revisium:password@localhost:${pgPort}/postgres`;
}

export function controlPlaneNotificationDatabaseUrl(): string | null {
  const runtime = readRuntime();
  if (!runtime || !isAlive(runtime.pid)) return null;
  return notificationDatabaseUrl(runtime.pgPort);
}

let pool: pg.Pool | null = null;
let poolUrl = '';

function getPool(url: string): pg.Pool {
  if (!pool || poolUrl !== url) {
    void pool?.end().catch(() => undefined);
    poolUrl = url;
    pool = new pg.Pool({ connectionString: url, max: 1 });
  }
  return pool;
}

export async function notifyControlPlaneChange(change: Omit<ControlPlaneChange, 'emittedAt'>): Promise<void> {
  const url = controlPlaneNotificationDatabaseUrl();
  if (!url) return;
  const payload = JSON.stringify({ ...change, emittedAt: new Date().toISOString() } satisfies ControlPlaneChange);
  try {
    await getPool(url).query('SELECT pg_notify($1, $2)', [CONTROL_PLANE_CHANGE_CHANNEL, payload]);
  } catch {
    // Subscriptions are an access-layer feed. A notification failure must not break the sealed write verb.
  }
}
