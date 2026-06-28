import { RevisiumClient, sdk } from '@revisium/client';
import type { Client, GetTableRowsDto } from '@revisium/client';
import { baseUrl, getConfig, isAlive, isHealthy, readRuntime } from '../config.js';
import { ControlPlaneError } from './errors.js';
import { runtimeTables } from './tables.js';
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
};

export type ControlPlaneTransport = {
  readonly mode: 'draft' | 'head';
  assertReady(): Promise<void>;
  listRows(table: string, options?: ListRowsOptions): Promise<TransportList>;
  getRow(table: string, rowId: string): Promise<TransportRow>;
  createRow(table: string, rowId: string, data: object): Promise<TransportRow>;
  updateRow(table: string, rowId: string, data: object): Promise<TransportRow>;
  patchRow(table: string, rowId: string, patches: PatchOperation[]): Promise<TransportRow>;
  /** Drop the cached read-scope so the next call re-resolves the current revision (a committed
   *  install_playbook must be visible to HEAD reads in the same daemon lifecycle, no restart).
   *  Optional so existing transport doubles/mocks need not provide it; callers guard with `canInvalidate`. */
  invalidate?(): void;
};

type ScopeContext = { revisionId: string; client: Client };
type RecoverableScopeResolver<T> = {
  resolve(): Promise<T>;
  invalidate(): void;
};
type TablesData = NonNullable<Awaited<ReturnType<typeof sdk.tables>>['data']>;
type RowsData = NonNullable<Awaited<ReturnType<typeof sdk.rows>>['data']>;
type RowData = NonNullable<Awaited<ReturnType<typeof sdk.row>>['data']>;
type CreateRowData = NonNullable<Awaited<ReturnType<typeof sdk.createRow>>['data']>;
type MutationRowData = NonNullable<Awaited<ReturnType<typeof sdk.updateRow>>['data']>;

/**
 * Per-request timeout for Revisium HTTP calls. Without it, an unresponsive daemon makes a single
 * fetch hang until the OS resets the socket (~minutes), stalling the host/CLI/MCP and making
 * `waitForRun` blow past its own deadline (which is only checked *between* calls, not during a hung
 * one). 15s sits well above any healthy call yet fails a hung daemon fast.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Wrap a fetch so every request aborts after `timeoutMs`, preserving any caller-supplied signal. */
export function withRequestTimeout(baseFetch: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return baseFetch(input, { ...init, signal });
  };
}

export function makeRecoverableScopeResolver<T>(loadScope: () => Promise<T>): RecoverableScopeResolver<T> {
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

function mapApiError(err: unknown, context: string): ControlPlaneError {
  if (err instanceof ControlPlaneError) return err;
  const apiErr = err as { statusCode?: number; message?: string };
  const status = apiErr.statusCode;
  const message = apiErr.message ?? String(err);

  if (status === 404) {
    return new ControlPlaneError('ROW_NOT_FOUND', `Row not found: ${context}`, { status, details: err });
  }
  if (status === 409 || (status === 400 && message.startsWith('Rows already exist:'))) {
    return new ControlPlaneError('ROW_CONFLICT', `Row conflict: ${context}`, { status, details: err });
  }
  if (status === 400 || status === 422) {
    return new ControlPlaneError('VALIDATION_FAILURE', `Validation failure: ${context}`, { status, details: err });
  }
  return new ControlPlaneError('HTTP_ERROR', `HTTP error ${status ?? 'unknown'}: ${context}: ${message}`, {
    status,
    details: err,
  });
}

function toTransportRow(row: {
  id: string;
  data: Record<string, unknown>;
  readonly?: boolean;
  createdAt?: string;
  updatedAt?: string;
}): TransportRow {
  return {
    id: row.id,
    data: row.data,
    readonly: row.readonly,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type SdkListEdge = {
  cursor?: string;
  node?: {
    id: string;
    data: Record<string, unknown>;
    readonly?: boolean;
    createdAt?: string;
    updatedAt?: string;
  };
};

export function mapTransportListEdges(edges: SdkListEdge[]): TransportList['edges'] {
  return edges.flatMap((edge) => edge.node ? [{ cursor: edge.cursor, node: toTransportRow(edge.node) }] : []);
}

export function extractMutationRow(result: {
  data?: { row?: { id: string; data: Record<string, unknown>; readonly?: boolean; createdAt?: string; updatedAt?: string } };
}): { id: string; data: Record<string, unknown>; readonly?: boolean; createdAt?: string; updatedAt?: string } {
  const row = result.data?.row;
  if (!row) throw new ControlPlaneError('HTTP_ERROR', 'Malformed response');
  return row;
}

async function getScope(mode: RevisionMode): Promise<ScopeContext> {
  const runtime = readRuntime();
  if (!runtime || !isAlive(runtime.pid) || !(await isHealthy(runtime.httpPort))) {
    throw new ControlPlaneError('DAEMON_NOT_RUNNING', 'Local Revisium daemon is not running or healthy');
  }

  const { org, project, branch } = getConfig();
  const revisiumClient = new RevisiumClient({ baseUrl: baseUrl(runtime.httpPort) });
  const clientInstance = revisiumClient.client;
  // Bound every request so an unresponsive daemon fails fast instead of hanging for minutes.
  clientInstance.setConfig({ fetch: withRequestTimeout(globalThis.fetch, REQUEST_TIMEOUT_MS) });

  // Use sdk.draftRevision / sdk.headRevision directly (not revisiumClient.revision()) so that
  // result.error retains statusCode. revisiumClient.revision() routes through unwrap() which throws
  // a plain Error(message) and discards statusCode, making 404 indistinguishable from other errors.
  const result =
    mode === 'draft'
      ? await sdk.draftRevision({ client: clientInstance, path: { organizationId: org, projectName: project, branchName: branch } })
      : await sdk.headRevision({ client: clientInstance, path: { organizationId: org, projectName: project, branchName: branch } });

  if (result.error) {
    const err = result.error as { statusCode?: number };
    if (err.statusCode === 404) {
      throw new ControlPlaneError(
        'BOOTSTRAP_NOT_APPLIED',
        `Control-plane bootstrap is missing or not committed: ${org}/${project}/${branch}`,
        { status: 404, details: result.error },
      );
    }
    throw mapApiError(result.error, `${org}/${project}/${branch}:${mode}`);
  }

  return { revisionId: result.data!.id, client: clientInstance };
}

export function createClientTransport(mode: RevisionMode): ControlPlaneTransport {
  const resolveScope = makeRecoverableScopeResolver<ScopeContext>(() => getScope(mode));

  async function withScopeRetry<T>(
    operation: (scope: ScopeContext) => Promise<{ data?: T; error?: unknown }>,
    context: string,
  ): Promise<T> {
    const firstScope = await resolveScope.resolve();
    const first = await operation(firstScope);
    if (!first.error) return first.data as T;

    const err = first.error as { statusCode?: number };
    if (mode === 'draft' && err.statusCode === 404) {
      resolveScope.invalidate();
      const secondScope = await resolveScope.resolve();
      const second = await operation(secondScope);
      if (!second.error) return second.data as T;
      throw mapApiError(second.error, context);
    }

    throw mapApiError(first.error, context);
  }

  async function assertReady(): Promise<void> {
    let resultData: TablesData;
    try {
      resultData = await withScopeRetry<TablesData>(
        ({ revisionId, client }) => sdk.tables({ client, path: { revisionId }, query: { first: 100 } }),
        '/tables',
      );
    } catch (error) {
      if (error instanceof ControlPlaneError && error.status === 404) {
        throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Control-plane bootstrap is missing or not committed', {
          status: 404,
          details: error.details,
        });
      }
      throw error;
    }
    const tableIds = new Set(
      (resultData?.edges ?? []).flatMap((edge: { node?: { id: string } }) => edge.node ? [edge.node.id] : []),
    );
    const missing = runtimeTables.filter((t) => !tableIds.has(t));
    if (missing.length > 0) {
      throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Control-plane bootstrap is missing runtime tables', {
        details: { missing },
      });
    }
  }

  async function listRows(table: string, options?: ListRowsOptions): Promise<TransportList> {
    const body: GetTableRowsDto = {
      first: options?.first ?? 100,
      after: options?.after,
      where: options?.where,
      orderBy: options?.orderBy,
    };
    const data = await withScopeRetry<RowsData>(
      ({ revisionId, client }) => sdk.rows({ client, path: { revisionId, tableId: table }, body }),
      `${table}/rows`,
    );
    const edges = mapTransportListEdges((data?.edges ?? []) as SdkListEdge[]);
    return { edges };
  }

  async function getRow(table: string, rowId: string): Promise<TransportRow> {
    const data = await withScopeRetry<RowData>(
      ({ revisionId, client }) => sdk.row({ client, path: { revisionId, tableId: table, rowId } }),
      `${table}/${rowId}`,
    );
    return toTransportRow(data);
  }

  async function createRow(table: string, rowId: string, data: object): Promise<TransportRow> {
    const resultData = await withScopeRetry<CreateRowData>(
      ({ revisionId, client }) => sdk.createRow({
        client,
        path: { revisionId, tableId: table },
        body: { rowId, data: data as Record<string, unknown> },
      }),
      `${table}/${rowId}`,
    );
    return toTransportRow(resultData!.row);
  }

  async function updateRow(table: string, rowId: string, data: object): Promise<TransportRow> {
    const resultData = await withScopeRetry<MutationRowData>(
      ({ revisionId, client }) => sdk.updateRow({
        client,
        path: { revisionId, tableId: table, rowId },
        body: { data: data as Record<string, unknown> },
      }),
      `${table}/${rowId}`,
    );
    return toTransportRow(extractMutationRow({ data: resultData }));
  }

  async function patchRow(table: string, rowId: string, patches: PatchOperation[]): Promise<TransportRow> {
    const resultData = await withScopeRetry<MutationRowData>(
      ({ revisionId, client }) => sdk.patchRow({
        client,
        path: { revisionId, tableId: table, rowId },
        body: { patches: patches as Array<{ op: 'replace'; path: string; value?: unknown }> },
      }),
      `${table}/${rowId}`,
    );
    return toTransportRow(extractMutationRow({ data: resultData }));
  }

  return { mode, assertReady, listRows, getRow, createRow, updateRow, patchRow, invalidate: () => resolveScope.invalidate() };
}
