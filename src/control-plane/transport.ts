import type { ListRowsOptions } from './data-access.js';
import type { PatchOperation } from './json-fields.js';

export type RevisionMode = 'draft' | 'head';

export type TransportRow = {
  id: string;
  readonly?: boolean;
  createdAt?: string;
  updatedAt?: string;
  data?: Record<string, unknown>;
};

export type TransportList = {
  edges?: Array<{ cursor?: string; node?: TransportRow }>;
  totalCount?: number;
  pageInfo?: {
    startCursor?: string;
    endCursor?: string;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
};

export type ControlPlaneTransport = {
  readonly mode: 'draft' | 'head';
  assertReady(): Promise<void>;
  listRows(table: string, options?: ListRowsOptions): Promise<TransportList>;
  getRow(table: string, rowId: string): Promise<TransportRow>;
  createRow(table: string, rowId: string, data: object): Promise<TransportRow>;
  updateRow(table: string, rowId: string, data: object): Promise<TransportRow>;
  patchRow(
    table: string,
    rowId: string,
    patches: PatchOperation[],
  ): Promise<TransportRow>;

  invalidate?(): void;
};

type RecoverableScopeResolver<T> = {
  resolve(): Promise<T>;
  invalidate(): void;
};

export function makeRecoverableScopeResolver<T>(
  loadScope: () => Promise<T>,
): RecoverableScopeResolver<T> {
  let cachedScope: Promise<T> | undefined;
  return {
    resolve() {
      cachedScope ??= loadScope().catch((error: unknown) => {
        cachedScope = undefined;
        throw error;
      });
      return cachedScope;
    },
    invalidate() {
      cachedScope = undefined;
    },
  };
}
