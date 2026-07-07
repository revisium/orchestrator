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

export type VersionedMeaningRevision = {
  id?: unknown;
};

export type VersionedMeaningScope = {
  getRow(tableId: string, rowId: string): Promise<unknown>;
  createRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  updateRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  commit(comment?: string): Promise<VersionedMeaningRevision>;
};

export type VersionedMeaningAccess = {
  upsertRow(row: VersionedMeaningRow): Promise<VersionedMeaningOperation>;
  commit(message: string): Promise<VersionedMeaningRevision | null>;
};

export type VersionedMeaningAccessOptions =
  | { dryRun: true; scopeFactory?: () => Promise<VersionedMeaningScope> }
  | { dryRun?: false; scopeFactory: () => Promise<VersionedMeaningScope> }
  | { dryRun: boolean; scopeFactory: () => Promise<VersionedMeaningScope> };

function isRowNotFound(error: unknown): boolean {
  const err = error as {
    statusCode?: number;
    status?: number;
    code?: string;
    message?: string;
  } | null;
  return (
    err?.statusCode === 404 ||
    err?.status === 404 ||
    err?.code === 'ROW_NOT_FOUND' ||
    (typeof err?.message === 'string' &&
      err.message.toLowerCase().includes('not found'))
  );
}

export function createVersionedMeaningAccess(
  options: VersionedMeaningAccessOptions,
): VersionedMeaningAccess {
  const dryRun = options.dryRun === true;
  const scopeFactory = options.scopeFactory;
  let scopePromise: Promise<VersionedMeaningScope> | undefined;

  function scope(): Promise<VersionedMeaningScope> {
    if (!scopeFactory) {
      throw new ControlPlaneError(
        'DAEMON_NOT_RUNNING',
        'Engine-backed versioned-meaning scope is not available',
      );
    }
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
