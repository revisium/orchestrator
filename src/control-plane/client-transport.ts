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
};

type ScopeContext = { revisionId: string; client: Client };

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
  let cachedScope: Promise<ScopeContext> | undefined;

  function resolveScope(): Promise<ScopeContext> {
    cachedScope ??= getScope(mode);
    return cachedScope;
  }

  async function assertReady(): Promise<void> {
    const { revisionId, client } = await resolveScope();
    const result = await sdk.tables({ client, path: { revisionId }, query: { first: 100 } });
    if (result.error) {
      const err = result.error as { statusCode?: number };
      if (err.statusCode === 404) {
        throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Control-plane bootstrap is missing or not committed', {
          status: 404,
          details: result.error,
        });
      }
      throw mapApiError(result.error, '/tables');
    }
    const tableIds = new Set(
      (result.data?.edges ?? []).flatMap((edge: { node?: { id: string } }) => edge.node ? [edge.node.id] : []),
    );
    const missing = runtimeTables.filter((t) => !tableIds.has(t));
    if (missing.length > 0) {
      throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'Control-plane bootstrap is missing runtime tables', {
        details: { missing },
      });
    }
  }

  async function listRows(table: string, options?: ListRowsOptions): Promise<TransportList> {
    const { revisionId, client } = await resolveScope();
    const body: GetTableRowsDto = {
      first: options?.first ?? 100,
      after: options?.after,
      where: options?.where,
      orderBy: options?.orderBy,
    };
    const result = await sdk.rows({ client, path: { revisionId, tableId: table }, body });
    if (result.error) throw mapApiError(result.error, `${table}/rows`);
    const edges = mapTransportListEdges((result.data?.edges ?? []) as SdkListEdge[]);
    return { edges };
  }

  async function getRow(table: string, rowId: string): Promise<TransportRow> {
    const { revisionId, client } = await resolveScope();
    const result = await sdk.row({ client, path: { revisionId, tableId: table, rowId } });
    if (result.error) throw mapApiError(result.error, `${table}/${rowId}`);
    return toTransportRow(result.data);
  }

  async function createRow(table: string, rowId: string, data: object): Promise<TransportRow> {
    const { revisionId, client } = await resolveScope();
    const result = await sdk.createRow({
      client,
      path: { revisionId, tableId: table },
      body: { rowId, data: data as Record<string, unknown> },
    });
    if (result.error) throw mapApiError(result.error, `${table}/${rowId}`);
    return toTransportRow(result.data!.row);
  }

  async function updateRow(table: string, rowId: string, data: object): Promise<TransportRow> {
    const { revisionId, client } = await resolveScope();
    const result = await sdk.updateRow({
      client,
      path: { revisionId, tableId: table, rowId },
      body: { data: data as Record<string, unknown> },
    });
    if (result.error) throw mapApiError(result.error, `${table}/${rowId}`);
    return toTransportRow(extractMutationRow(result));
  }

  async function patchRow(table: string, rowId: string, patches: PatchOperation[]): Promise<TransportRow> {
    const { revisionId, client } = await resolveScope();
    const result = await sdk.patchRow({
      client,
      path: { revisionId, tableId: table, rowId },
      body: { patches: patches as Array<{ op: 'replace'; path: string; value?: unknown }> },
    });
    if (result.error) throw mapApiError(result.error, `${table}/${rowId}`);
    return toTransportRow(extractMutationRow(result));
  }

  return { mode, assertReady, listRows, getRow, createRow, updateRow, patchRow };
}
