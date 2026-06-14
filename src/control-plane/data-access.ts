import type { OrderByDto, RowWhereInputDto } from '@revisium/client';
import { ControlPlaneError } from './errors.js';
import { deserializeData, serializeData, serializePatches, type PatchOperation } from './json-fields.js';
import {
  createClientTransport,
  type ControlPlaneTransport,
  type TransportRow,
} from './client-transport.js';
import { isRuntimeTable, type RuntimeTable } from './tables.js';

export type ListRowsOptions = {
  first?: number;
  after?: string;
  where?: RowWhereInputDto;
  orderBy?: OrderByDto[];
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

function assertRuntimeTable(table: RuntimeTable): void {
  if (!isRuntimeTable(table)) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `Unsupported runtime table: ${String(table)}`, {
      details: { table },
    });
  }
}

function rowPath(table: RuntimeTable, rowId: string): string {
  return `${table}/${rowId}`;
}

function mapRow(table: RuntimeTable, row: TransportRow, cursor?: string): ControlPlaneRow {
  return {
    rowId: row.id,
    data: deserializeData(table, row.id, row.data ?? {}),
    cursor,
    readonly: row.readonly,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createControlPlaneDataAccessForTransport(
  transport: ControlPlaneTransport,
): ControlPlaneDataAccess {
  function guardHead(): void {
    if (transport.mode === 'head') {
      throw new ControlPlaneError('VALIDATION_FAILURE', 'Writes are not allowed on head revision');
    }
  }

  return {
    assertReady: () => transport.assertReady(),

    async listRows(table, listOptions = {}) {
      assertRuntimeTable(table);
      const result = await transport.listRows(table, listOptions);
      return (result.edges ?? []).map((edge) => {
        if (!edge.node) {
          throw new ControlPlaneError('HTTP_ERROR', `Malformed list response for ${table}`, { details: result });
        }
        return mapRow(table, edge.node, edge.cursor);
      });
    },

    async getRow(table, rowId) {
      assertRuntimeTable(table);
      try {
        return mapRow(table, await transport.getRow(table, rowId));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') return null;
        throw error;
      }
    },

    async createRow(table, rowId, data) {
      guardHead();
      assertRuntimeTable(table);
      const serialized = serializeData(table, rowId, data);
      return mapRow(table, await transport.createRow(table, rowId, serialized));
    },

    async updateRow(table, rowId, data) {
      guardHead();
      assertRuntimeTable(table);
      const serialized = serializeData(table, rowId, data);
      try {
        return mapRow(table, await transport.updateRow(table, rowId, serialized));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
          throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot update missing row: ${rowPath(table, rowId)}`, {
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
    },

    async patchRow(table, rowId, patches) {
      guardHead();
      assertRuntimeTable(table);
      const serialized = serializePatches(table, patches);
      try {
        return mapRow(table, await transport.patchRow(table, rowId, serialized));
      } catch (error) {
        if (error instanceof ControlPlaneError && error.code === 'ROW_NOT_FOUND') {
          throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot patch missing row: ${rowPath(table, rowId)}`, {
            status: error.status,
            details: error.details,
          });
        }
        throw error;
      }
    },
  };
}

export function createControlPlaneDataAccess(options?: { revision?: 'draft' | 'head' }): ControlPlaneDataAccess {
  const mode = options?.revision ?? 'draft';
  return createControlPlaneDataAccessForTransport(createClientTransport(mode));
}

export type { PatchOperation } from './json-fields.js';
export type { ControlPlaneTransport, TransportRow, TransportList } from './client-transport.js';
