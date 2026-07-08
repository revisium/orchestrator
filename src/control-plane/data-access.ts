import type { PatchOperation } from './json-fields.js';
import type { RowOrderBy, RowWhereInput } from './query-types.js';
import type { RuntimeTable } from './tables.js';

export type ListRowsOptions = {
  first?: number;
  after?: string;
  where?: RowWhereInput;
  orderBy?: RowOrderBy[];
};

export type ControlPlaneRow<TData extends object = Record<string, unknown>> = {
  rowId: string;
  data: TData;
  cursor?: string;
  readonly?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ControlPlaneDataAccess = {
  assertReady(): Promise<void>;
  listRows(table: RuntimeTable, options?: ListRowsOptions): Promise<ControlPlaneRow[]>;
  getRow(table: RuntimeTable, rowId: string): Promise<ControlPlaneRow | null>;
  createRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>): Promise<ControlPlaneRow>;
  updateRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>): Promise<ControlPlaneRow>;
  patchRow(table: RuntimeTable, rowId: string, patches: PatchOperation[]): Promise<ControlPlaneRow>;
};

export type { PatchOperation } from './json-fields.js';
