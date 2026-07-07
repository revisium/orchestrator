import { randomUUID } from 'node:crypto';
import type {
  EngineApiService,
  InputJsonValue,
  RowWhereInput,
} from '@revisium/engine';
import { getConfig } from '../config.js';
import type { RevoPrismaService } from '../storage/revo-prisma.service.js';
import { ControlPlaneError } from './errors.js';
import { computeAdditiveSchemaPatches } from './schema-migration.js';
import { runtimeTables } from './tables.js';
import {
  makeRecoverableScopeResolver,
  type ControlPlaneTransport,
  type RevisionMode,
  type TransportList,
  type TransportRow,
} from './transport.js';
import type { ListRowsOptions, PatchOperation } from './data-access.js';
import type {
  VersionedMeaningRevision,
  VersionedMeaningScope,
} from './versioned-meaning.js';
import { ROW_ORDER_BY_FIELDS, type RowOrderByField } from './query-types.js';

const SYSTEM_TABLES = [
  'revisium_schema_table',
  'revisium_shared_schemas_table',
  'revisium_migration_table',
] as const;

type ScopeContext = { revisionId: string; branchId: string };
type BootstrapTable = { id: string; schema: Record<string, unknown> };
type EngineOrderBy = Record<string, 'asc' | 'desc'>;
type EngineTablesPage = {
  edges?: Array<{ cursor?: string; node?: { id: string } }>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
};

function isRowOrderByField(field: string): field is RowOrderByField {
  return (ROW_ORDER_BY_FIELDS as readonly string[]).includes(field);
}

function nowId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : undefined;
}

function toTransportRow(row: {
  id: string;
  data?: unknown;
  readonly?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}): TransportRow {
  return {
    id: row.id,
    data:
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    readonly: row.readonly,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  };
}

function mapOrderBy(
  orderBy: ListRowsOptions['orderBy'],
): EngineOrderBy[] | undefined {
  if (!orderBy || orderBy.length === 0) return undefined;
  return orderBy.flatMap((entry) => {
    const field = (entry as { field?: unknown }).field;
    const direction = (entry as { direction?: unknown }).direction;
    if (typeof field !== 'string') return [];
    if (direction !== 'asc' && direction !== 'desc') return [];
    if (!isRowOrderByField(field)) return [];
    return [{ [field]: direction }];
  });
}

function statusCode(error: unknown): number | undefined {
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    getStatus?: () => number;
  } | null;
  if (typeof err?.status === 'number') return err.status;
  if (typeof err?.statusCode === 'number') return err.statusCode;
  if (typeof err?.getStatus === 'function') return err.getStatus();
  return undefined;
}

function mapEngineError(error: unknown, context: string): ControlPlaneError {
  if (error instanceof ControlPlaneError) return error;
  const status = statusCode(error);
  const message = error instanceof Error ? error.message : String(error);
  if (status === 404 || /not found/i.test(message)) {
    return new ControlPlaneError('ROW_NOT_FOUND', `Row not found: ${context}`, {
      status,
      details: error,
    });
  }
  if (
    status === 409 ||
    (status === 400 && message.startsWith('Rows already exist:'))
  ) {
    return new ControlPlaneError('ROW_CONFLICT', `Row conflict: ${context}`, {
      status,
      details: error,
    });
  }
  if (status === 400 || status === 422) {
    return new ControlPlaneError(
      'VALIDATION_FAILURE',
      `Validation failure: ${context}`,
      { status, details: error },
    );
  }
  return new ControlPlaneError(
    'TRANSPORT_ERROR',
    `Engine error ${status ?? 'unknown'}: ${context}: ${message}`,
    {
      status,
      details: error,
    },
  );
}

function isEngineNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    statusCode(error) === 404 ||
    /not found/i.test(message) ||
    /table .*does not exist|does not exist in the revision/i.test(message)
  );
}

function isStaleDraftScopeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    statusCode(error) === 404 ||
    (statusCode(error) === 400 && /not a draft/i.test(message))
  );
}

export async function ensureControlPlaneProject(
  prisma: RevoPrismaService,
): Promise<void> {
  const { project, branch } = getConfig();
  await prisma.revoProject.upsert({
    where: { id: project },
    create: {
      id: project,
      slug: project,
      name: project,
      kind: 'SYSTEM',
      status: 'ACTIVE',
    },
    update: {
      slug: project,
      name: project,
      kind: 'SYSTEM',
      status: 'ACTIVE',
      deletedAt: null,
    },
  });

  const existing = await prisma.branch.findUnique({
    where: { name_projectId: { name: branch, projectId: project } },
    select: { id: true },
  });
  if (existing) return;

  const branchId = nowId('branch');
  const headRevisionId = nowId('revision');
  const draftRevisionId = nowId('revision');

  await prisma.$transaction(async (tx) => {
    const raced = await tx.branch.findUnique({
      where: { name_projectId: { name: branch, projectId: project } },
      select: { id: true },
    });
    if (raced) return;

    await tx.branch.create({
      data: {
        id: branchId,
        name: branch,
        isRoot: true,
        projectId: project,
      },
    });
    await tx.revision.create({
      data: {
        id: headRevisionId,
        branchId,
        isHead: true,
        isStart: true,
        hasChanges: false,
      },
    });
    await tx.revision.create({
      data: {
        id: draftRevisionId,
        branchId,
        parentId: headRevisionId,
        isDraft: true,
        hasChanges: false,
      },
    });
    for (const tableId of SYSTEM_TABLES) {
      await tx.table.create({
        data: {
          id: tableId,
          versionId: nowId('table'),
          createdId: nowId('table-created'),
          readonly: true,
          system: true,
          revisions: {
            connect: [{ id: headRevisionId }, { id: draftRevisionId }],
          },
        },
      });
    }
  });
}

async function resolveScope(
  mode: RevisionMode,
  engine: EngineApiService,
  prisma: RevoPrismaService,
): Promise<ScopeContext> {
  await ensureControlPlaneProject(prisma);
  const { project, branch } = getConfig();
  const branchRow = await engine.getBranch({
    projectId: project,
    branchName: branch,
  });
  const revision =
    mode === 'draft'
      ? await engine.getDraftRevision(branchRow.id)
      : await engine.getHeadRevision(branchRow.id);
  return { branchId: branchRow.id, revisionId: revision.id };
}

export function createEngineTransport(
  mode: RevisionMode,
  engine: EngineApiService,
  prisma: RevoPrismaService,
): ControlPlaneTransport {
  const scope = makeRecoverableScopeResolver(() =>
    resolveScope(mode, engine, prisma),
  );

  async function withScopeRetry<T>(
    operation: (revisionId: string) => Promise<T>,
    context: string,
  ): Promise<T> {
    const firstScope = await scope.resolve();
    try {
      return await operation(firstScope.revisionId);
    } catch (firstError) {
      if (mode === 'draft' && isStaleDraftScopeError(firstError)) {
        scope.invalidate();
        const secondScope = await scope.resolve();
        try {
          return await operation(secondScope.revisionId);
        } catch (secondError) {
          throw mapEngineError(secondError, context);
        }
      }
      throw mapEngineError(firstError, context);
    }
  }

  async function assertReady(): Promise<void> {
    const tableIds = await withScopeRetry(async (revisionId) => {
      const ids = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const tables = (await engine.getTables({
          revisionId,
          first: 100,
          after,
        })) as EngineTablesPage;
        let lastCursor: string | undefined;
        for (const edge of tables.edges ?? []) {
          lastCursor = edge.cursor ?? lastCursor;
          if (edge.node) ids.add(edge.node.id);
        }
        if (runtimeTables.every((table) => ids.has(table))) return ids;
        if (!tables.pageInfo?.hasNextPage) return ids;
        after = tables.pageInfo.endCursor ?? lastCursor;
        if (!after) return ids;
      }
    }, '/tables');
    const missing = runtimeTables.filter((table) => !tableIds.has(table));
    if (missing.length > 0) {
      throw new ControlPlaneError(
        'BOOTSTRAP_NOT_APPLIED',
        'Control-plane bootstrap is missing runtime tables',
        {
          details: { missing },
        },
      );
    }
  }

  return {
    mode,
    assertReady,
    async listRows(
      table: string,
      options?: ListRowsOptions,
    ): Promise<TransportList> {
      const rows = await withScopeRetry(
        (revisionId) =>
          engine.getRows({
            revisionId,
            tableId: table,
            first: options?.first ?? 100,
            after: options?.after,
            orderBy: mapOrderBy(options?.orderBy) as never,
            where: options?.where as RowWhereInput | undefined,
          }),
        `${table}/rows`,
      );
      return {
        edges: (rows.edges ?? []).flatMap(
          (edge: {
            cursor?: string;
            node?: Parameters<typeof toTransportRow>[0];
          }) =>
            edge.node
              ? [{ cursor: edge.cursor, node: toTransportRow(edge.node) }]
              : [],
        ),
      };
    },
    async getRow(table: string, rowId: string): Promise<TransportRow> {
      const row = await withScopeRetry(
        (revisionId) => engine.getRow({ revisionId, tableId: table, rowId }),
        `${table}/${rowId}`,
      );
      if (!row) {
        throw new ControlPlaneError(
          'ROW_NOT_FOUND',
          `Row not found: ${table}/${rowId}`,
          { status: 404 },
        );
      }
      return toTransportRow(row);
    },
    async createRow(
      table: string,
      rowId: string,
      data: object,
    ): Promise<TransportRow> {
      const result = await withScopeRetry(
        (revisionId) =>
          engine.createRow({
            revisionId,
            tableId: table,
            rowId,
            data: data as InputJsonValue,
          }),
        `${table}/${rowId}`,
      );
      if (!result.row)
        throw new ControlPlaneError(
          'ROW_NOT_FOUND',
          `Row not found: ${table}/${rowId}`,
          { status: 404 },
        );
      return toTransportRow(result.row);
    },
    async updateRow(
      table: string,
      rowId: string,
      data: object,
    ): Promise<TransportRow> {
      const result = await withScopeRetry(
        (revisionId) =>
          engine.updateRow({
            revisionId,
            tableId: table,
            rowId,
            data: data as InputJsonValue,
          }),
        `${table}/${rowId}`,
      );
      if (!result.row)
        throw new ControlPlaneError(
          'ROW_NOT_FOUND',
          `Row not found: ${table}/${rowId}`,
          { status: 404 },
        );
      return toTransportRow(result.row);
    },
    async patchRow(
      table: string,
      rowId: string,
      patches: PatchOperation[],
    ): Promise<TransportRow> {
      const result = await withScopeRetry(
        (revisionId) =>
          engine.patchRow({
            revisionId,
            tableId: table,
            rowId,
            patches: patches as never,
          }),
        `${table}/${rowId}`,
      );
      if (!result.row)
        throw new ControlPlaneError(
          'ROW_NOT_FOUND',
          `Row not found: ${table}/${rowId}`,
          { status: 404 },
        );
      return toTransportRow(result.row);
    },
    invalidate: () => scope.invalidate(),
  };
}

export function createEngineVersionedMeaningScope(
  engine: EngineApiService,
  prisma: RevoPrismaService,
): VersionedMeaningScope {
  const draft = createEngineTransport('draft', engine, prisma);
  return {
    getRow: (tableId, rowId) => draft.getRow(tableId, rowId),
    createRow: (tableId, rowId, data) => draft.createRow(tableId, rowId, data),
    updateRow: (tableId, rowId, data) => draft.updateRow(tableId, rowId, data),
    async commit(comment?: string): Promise<VersionedMeaningRevision> {
      const { project, branch } = getConfig();
      const revision = await engine.createRevision({
        projectId: project,
        branchName: branch,
        comment,
      });
      draft.invalidate?.();
      return revision;
    },
  };
}

export async function applyEngineBootstrapTables(
  engine: EngineApiService,
  prisma: RevoPrismaService,
  tables: BootstrapTable[],
): Promise<number> {
  await ensureControlPlaneProject(prisma);
  const { revisionId } = await resolveScope('draft', engine, prisma);
  let changes = 0;
  for (const table of tables) {
    let currentSchema: unknown;
    try {
      currentSchema = await engine.resolveTableSchema({
        revisionId,
        tableId: table.id,
      });
    } catch (error) {
      if (!isEngineNotFoundError(error)) throw error;
      await engine.createTable({
        revisionId,
        tableId: table.id,
        schema: table.schema as InputJsonValue,
      });
      changes += 1;
      continue;
    }
    const patches = computeAdditiveSchemaPatches(currentSchema, table.schema);
    if (patches.length === 0) continue;
    await engine.updateTable({
      revisionId,
      tableId: table.id,
      patches: patches as never,
    });
    changes += patches.length;
  }
  return changes;
}
