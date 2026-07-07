import type {
  ControlPlaneDataAccess,
  ControlPlaneRow,
  ListRowsOptions,
  PatchOperation,
} from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { RowWhereInput } from '../control-plane/query-types.js';
import { isRuntimeTable, runtimeTables, type RuntimeTable } from '../control-plane/tables.js';

export type RuntimeDataAccessCall =
  | { method: 'assertReady' }
  | { method: 'listRows'; table: RuntimeTable; options: ListRowsOptions }
  | { method: 'getRow'; table: RuntimeTable; rowId: string }
  | { method: 'createRow' | 'updateRow'; table: RuntimeTable; rowId: string; data: Record<string, unknown> }
  | { method: 'patchRow'; table: RuntimeTable; rowId: string; patches: PatchOperation[] };

export type RuntimeDataAccessSeed = Partial<Record<RuntimeTable, Record<string, Record<string, unknown>>>>;

type RuntimeDataAccessStore = Record<RuntimeTable, Map<string, ControlPlaneRow>>;

function emptyStore(): RuntimeDataAccessStore {
  return Object.fromEntries(runtimeTables.map((table) => [table, new Map()])) as RuntimeDataAccessStore;
}

function cloneData(data: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(data);
}

function makeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  const createdAt = typeof data.created_at === 'string' ? data.created_at : '2026-06-07T10:00:00.000Z';
  const updatedAt = typeof data.updated_at === 'string' ? data.updated_at : createdAt;
  return {
    rowId,
    data: cloneData({ ...data, id: data.id ?? rowId }),
    cursor: rowId,
    createdAt,
    updatedAt,
  };
}

function assertRuntimeTable(table: RuntimeTable): void {
  if (!isRuntimeTable(table)) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `Unsupported runtime table: ${String(table)}`);
  }
}

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, data);
}

function comparableString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function matchesIdWhere(row: ControlPlaneRow, where: RowWhereInput): boolean {
  if (where.id?.equals !== undefined && row.rowId !== where.id.equals) return false;
  if (where.id?.in !== undefined && !where.id.in.includes(row.rowId)) return false;
  return true;
}

function matchesDataWhere(row: ControlPlaneRow, where: RowWhereInput): boolean {
  const path = where.data?.path;
  if (path === undefined) return true;
  if (typeof path !== 'string') return false;

  const actual = valueAtPath(row.data, path);
  if (where.data?.equals !== undefined && actual !== where.data.equals) return false;
  if (where.data?.in !== undefined && !where.data.in.includes(actual)) return false;
  return true;
}

function matchesNotWhere(row: ControlPlaneRow, not: RowWhereInput['NOT']): boolean {
  if (Array.isArray(not)) return !not.some((item) => matchesWhere(row, item));
  return not ? !matchesWhere(row, not) : true;
}

function matchesLogicalWhere(row: ControlPlaneRow, where: RowWhereInput): boolean {
  if (where.AND?.some((item) => !matchesWhere(row, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(row, item))) return false;
  return matchesNotWhere(row, where.NOT);
}

function matchesWhere(row: ControlPlaneRow, where: RowWhereInput | undefined): boolean {
  if (!where) return true;
  return matchesIdWhere(row, where) && matchesDataWhere(row, where) && matchesLogicalWhere(row, where);
}

function compareRows(field: string, a: ControlPlaneRow, b: ControlPlaneRow): number {
  if (field === 'id') return a.rowId.localeCompare(b.rowId);
  if (field === 'updatedAt') return (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '');
  if (field === 'sequence' || field === 'ordinal') {
    const diff = Number(a.data[field] ?? 0) - Number(b.data[field] ?? 0);
    if (diff !== 0) return diff;
  }
  if (field === 'producedAt') return comparableString(a.data.produced_at).localeCompare(comparableString(b.data.produced_at));
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}

function patchRoot(path: string): string {
  return path.replace(/^\/+/, '').split(/[/.]/, 1)[0] ?? '';
}

function applyPatches(data: Record<string, unknown>, patches: PatchOperation[]): Record<string, unknown> {
  const next = cloneData(data);
  for (const patch of patches) {
    const root = patchRoot(patch.path);
    if (!root) continue;
    if (patch.op === 'remove') {
      delete next[root];
      continue;
    }
    next[root] = patch.value;
  }
  return next;
}

export function createInMemoryRuntimeDataAccess(seed: RuntimeDataAccessSeed = {}): {
  access: ControlPlaneDataAccess;
  calls: RuntimeDataAccessCall[];
  store: RuntimeDataAccessStore;
} {
  const calls: RuntimeDataAccessCall[] = [];
  const store = emptyStore();

  for (const [table, rows] of Object.entries(seed) as Array<[RuntimeTable, Record<string, Record<string, unknown>>]>) {
    assertRuntimeTable(table);
    for (const [rowId, data] of Object.entries(rows)) {
      store[table].set(rowId, makeRow(rowId, data));
    }
  }

  const access: ControlPlaneDataAccess = {
    async assertReady() {
      calls.push({ method: 'assertReady' });
    },

    async listRows(table, options = {}) {
      assertRuntimeTable(table);
      calls.push({ method: 'listRows', table, options });
      let rows = Array.from(store[table].values()).filter((row) => matchesWhere(row, options.where));
      for (const order of [...(options.orderBy ?? [])].reverse()) {
        const direction = order.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => compareRows(order.field, a, b) * direction);
      }
      const afterIndex = options.after ? rows.findIndex((row) => row.cursor === options.after || row.rowId === options.after) : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      const take = options.first ?? rows.length;
      return rows.slice(start, start + take).map((row) => ({ ...row, data: cloneData(row.data) }));
    },

    async getRow(table, rowId) {
      assertRuntimeTable(table);
      calls.push({ method: 'getRow', table, rowId });
      const row = store[table].get(rowId);
      return row ? { ...row, data: cloneData(row.data) } : null;
    },

    async createRow(table, rowId, data) {
      assertRuntimeTable(table);
      calls.push({ method: 'createRow', table, rowId, data: cloneData(data) });
      if (store[table].has(rowId)) {
        throw new ControlPlaneError('ROW_CONFLICT', `Duplicate runtime row: ${table}/${rowId}`);
      }
      const row = makeRow(rowId, data);
      store[table].set(rowId, row);
      return { ...row, data: cloneData(row.data) };
    },

    async updateRow(table, rowId, data) {
      assertRuntimeTable(table);
      calls.push({ method: 'updateRow', table, rowId, data: cloneData(data) });
      if (!store[table].has(rowId)) {
        throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot update missing runtime row: ${table}/${rowId}`);
      }
      const row = makeRow(rowId, data);
      store[table].set(rowId, row);
      return { ...row, data: cloneData(row.data) };
    },

    async patchRow(table, rowId, patches) {
      assertRuntimeTable(table);
      calls.push({ method: 'patchRow', table, rowId, patches: cloneData({ patches }).patches as PatchOperation[] });
      const current = store[table].get(rowId);
      if (!current) {
        throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot patch missing runtime row: ${table}/${rowId}`);
      }
      const row = makeRow(rowId, applyPatches(current.data, patches));
      store[table].set(rowId, row);
      return { ...row, data: cloneData(row.data) };
    },
  };

  return { access, calls, store };
}
