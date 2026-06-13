import { RevisiumClient } from '@revisium/client';
import { baseUrl, getConfig, isAlive, isHealthy, readRuntime } from '../config.js';
import { ControlPlaneError } from './errors.js';

export type VersionedMeaningTable = 'playbooks' | 'roles' | 'pipelines';

export type VersionedMeaningRow = {
  table: VersionedMeaningTable;
  rowId: string;
  data: Record<string, unknown>;
};

export type VersionedMeaningOperation = {
  action: 'dry-run' | 'create' | 'update';
  table: VersionedMeaningTable;
  rowId: string;
};

export type VersionedMeaningScope = {
  getRow(tableId: string, rowId: string): Promise<unknown>;
  createRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  updateRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  commit(comment?: string): Promise<unknown>;
};

export type VersionedMeaningAccess = {
  upsertRow(row: VersionedMeaningRow): Promise<VersionedMeaningOperation>;
  commit(message: string): Promise<unknown | null>;
};

export type VersionedMeaningAccessOptions = {
  dryRun?: boolean;
  scopeFactory?: () => Promise<VersionedMeaningScope>;
};

function isRowNotFound(error: unknown): boolean {
  const err = error as { statusCode?: number; status?: number; code?: string; message?: string } | null;
  return (
    err?.statusCode === 404 ||
    err?.status === 404 ||
    err?.code === 'ROW_NOT_FOUND' ||
    (typeof err?.message === 'string' && err.message.toLowerCase().includes('not found'))
  );
}

async function createDraftScope(): Promise<VersionedMeaningScope> {
  const runtime = readRuntime();
  if (!runtime || !isAlive(runtime.pid) || !(await isHealthy(runtime.httpPort))) {
    throw new ControlPlaneError('DAEMON_NOT_RUNNING', 'Local Revisium daemon is not running or healthy');
  }

  const { org, project, branch } = getConfig();
  const client = new RevisiumClient({ baseUrl: baseUrl(runtime.httpPort) });
  return client.revision({ org, project, branch, revision: 'draft' });
}

export function createVersionedMeaningAccess(
  options: VersionedMeaningAccessOptions = {},
): VersionedMeaningAccess {
  const dryRun = options.dryRun ?? false;
  const scopeFactory = options.scopeFactory ?? createDraftScope;
  let scopePromise: Promise<VersionedMeaningScope> | undefined;

  function scope(): Promise<VersionedMeaningScope> {
    scopePromise ??= scopeFactory();
    return scopePromise;
  }

  return {
    async upsertRow(row) {
      if (dryRun) {
        return { action: 'dry-run', table: row.table, rowId: row.rowId };
      }

      const draft = await scope();
      try {
        await draft.getRow(row.table, row.rowId);
      } catch (error) {
        if (!isRowNotFound(error)) throw error;
        await draft.createRow(row.table, row.rowId, row.data);
        return { action: 'create', table: row.table, rowId: row.rowId };
      }

      await draft.updateRow(row.table, row.rowId, row.data);
      return { action: 'update', table: row.table, rowId: row.rowId };
    },

    async commit(message) {
      if (dryRun) return null;
      return (await scope()).commit(message);
    },
  };
}
