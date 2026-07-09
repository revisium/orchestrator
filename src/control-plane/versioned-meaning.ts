import { ControlPlaneError } from './errors.js';
import type { RowWhereInput } from './query-types.js';

export type VersionedMeaningTable = 'playbooks' | 'roles' | 'pipelines' | 'run_profiles';
export type VersionedMeaningCatalogTable = Exclude<VersionedMeaningTable, 'playbooks'>;

export type VersionedMeaningRow = {
  table: VersionedMeaningTable;
  rowId: string;
  data: Record<string, unknown>;
};

export type VersionedMeaningOperation = {
  action: 'dry-run' | 'create' | 'update' | 'retire' | 'preserve';
  table: VersionedMeaningTable;
  rowId: string;
};

export type VersionedMeaningRevision = {
  id?: unknown;
};

export type VersionedMeaningListOptions = {
  first?: number;
  after?: string;
  where?: RowWhereInput;
};

type VersionedMeaningListedRow = { id: string; data?: Record<string, unknown>; cursor?: string };

export type VersionedMeaningScope = {
  listRows(tableId: string, options?: VersionedMeaningListOptions): Promise<VersionedMeaningListedRow[]>;
  getRow(tableId: string, rowId: string): Promise<unknown>;
  createRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  updateRow(tableId: string, rowId: string, data: object): Promise<unknown>;
  commit(comment?: string): Promise<VersionedMeaningRevision>;
};

export type VersionedMeaningAccess = {
  upsertRow(row: VersionedMeaningRow): Promise<VersionedMeaningOperation>;
  retireMissingRows(input: {
    table: VersionedMeaningCatalogTable;
    playbookId: string;
    keepRowIds: readonly string[];
    retiredAt: string;
  }): Promise<VersionedMeaningOperation[]>;
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

function objectData(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function dataEquals(path: string, equals: string): RowWhereInput {
  return { data: { path, equals } };
}

const RETIRE_PAGE_SIZE = 500;

function isCatalogCleanRunProfile(data: Record<string, unknown>): boolean {
  return typeof data.source_hash === 'string' &&
    data.source_hash.length > 0 &&
    data.profile_hash === data.source_hash;
}

function shouldPreserveCatalogUpsert(table: VersionedMeaningTable, data: Record<string, unknown>): boolean {
  if (table !== 'run_profiles') return false;
  return !isCatalogCleanRunProfile(data);
}

function retirableCatalogRow(
  row: VersionedMeaningListedRow,
  playbookId: string,
  keepRowIds: ReadonlySet<string>,
  table: VersionedMeaningCatalogTable,
): Record<string, unknown> | null {
  const data = objectData(row.data);
  if (data.playbook_id !== playbookId) return null;
  if (keepRowIds.has(row.id)) return null;
  if (data.status === 'removed') return null;
  if (table === 'run_profiles' && !isCatalogCleanRunProfile(data)) return null;
  return data;
}

function nextRetireCursor(rows: VersionedMeaningListedRow[]): string | undefined {
  return rows.length < RETIRE_PAGE_SIZE ? undefined : rows.at(-1)?.cursor;
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
        'CONTROL_PLANE_NOT_AVAILABLE',
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
        const existing = await draft.getRow(row.table, row.rowId);
        if (shouldPreserveCatalogUpsert(row.table, objectData((existing as { data?: unknown }).data))) {
          return { action: 'preserve', table: row.table, rowId: row.rowId };
        }
      } catch (error) {
        if (!isRowNotFound(error)) throw error;
        await draft.createRow(row.table, row.rowId, row.data);
        return { action: 'create', table: row.table, rowId: row.rowId };
      }

      await draft.updateRow(row.table, row.rowId, row.data);
      return { action: 'update', table: row.table, rowId: row.rowId };
    },

    async retireMissingRows(input) {
      if (dryRun) return [];
      const keep = new Set(input.keepRowIds);
      const draft = await scope();
      const operations: VersionedMeaningOperation[] = [];
      let after: string | undefined;

      do {
        const existingRows = await draft.listRows(input.table, {
          first: RETIRE_PAGE_SIZE,
          after,
          where: dataEquals('playbook_id', input.playbookId),
        });

        for (const existing of existingRows) {
          const data = retirableCatalogRow(existing, input.playbookId, keep, input.table);
          if (!data) continue;

          await draft.updateRow(input.table, existing.id, {
            ...data,
            status: 'removed',
            retired_at: input.retiredAt,
            updated_at: input.retiredAt,
          });
          operations.push({ action: 'retire', table: input.table, rowId: existing.id });
        }

        after = nextRetireCursor(existingRows);
      } while (after);

      return operations;
    },

    async commit(message) {
      if (dryRun) return null;
      return (await scope()).commit(message);
    },
  };
}
