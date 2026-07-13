import { Prisma } from '../__generated__/client/client.js';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from '../control-plane/data-access.js';
import { notifyControlPlaneChange } from '../control-plane/change-notifications.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { RowWhereInput } from '../control-plane/query-types.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import type { RevoPrismaService } from '../storage/revo-prisma.service.js';

type RuntimeRecord = Record<string, unknown>;
type RuntimeOrderBy = Array<Record<string, 'asc' | 'desc'>>;
type RuntimeModel = {
  findUnique(args: { where: { id: string } }): Promise<unknown>;
  findMany(args: {
    where: RuntimeRecord;
    orderBy: RuntimeOrderBy;
    take: number;
    skip?: number;
    cursor?: { id: string };
  }): Promise<unknown[]>;
};
type RuntimeModelTable = Exclude<RuntimeTable, 'steps'>;

const TABLES = new Set<RuntimeTable>([
  'task_runs',
  'tasks',
  'steps',
  'attempts',
  'events',
  'inbox',
  'cost_ledger',
  'run_outputs',
]);

function assertTable(table: RuntimeTable): void {
  if (!TABLES.has(table)) {
    throw new ControlPlaneError('VALIDATION_FAILURE', `Unsupported runtime table: ${String(table)}`);
  }
}

function isConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return '';
}

function dateValue(value: unknown, fallback = new Date()): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' && value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

function nullableDate(value: unknown): Date | null {
  if (value === '' || value === null || value === undefined) return null;
  return dateValue(value);
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function requiredProvenance(value: unknown, field: 'runner_id' | 'provider' | 'model_id'): string {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  throw new ControlPlaneError('VALIDATION_FAILURE', `${field} must be a non-empty exact provenance value`);
}

function int(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableDecimalNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const toNumber = (value as { toNumber?: unknown }).toNumber;
    if (typeof toNumber === 'function') return nullableNum(toNumber.call(value));
  }
  return nullableNum(value);
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function json(value: unknown, fallback: unknown): Prisma.InputJsonValue {
  if (value === undefined) return fallback as Prisma.InputJsonValue;
  if (value === null) return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  return value as Prisma.InputJsonValue;
}

function row(table: RuntimeTable, rowId: string, data: RuntimeRecord, createdAt?: Date | string, updatedAt?: Date | string): ControlPlaneRow {
  return {
    rowId,
    data,
    cursor: rowId,
    createdAt: iso(createdAt),
    updatedAt: iso(updatedAt ?? createdAt),
  };
}

function patchRoot(path: string): string {
  return path.replace(/^\/+/, '').split(/[/.]/, 1)[0] ?? '';
}

function applyPatches(data: RuntimeRecord, patches: PatchOperation[]): RuntimeRecord {
  const next: RuntimeRecord = { ...data };
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

function whereId(where?: RowWhereInput): { equals?: string; in?: string[] } {
  const id = where?.id;
  return {
    equals: typeof id?.equals === 'string' ? id.equals : undefined,
    in: Array.isArray(id?.in) ? id.in.filter((item): item is string => typeof item === 'string') : undefined,
  };
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function orderBy(table: RuntimeTable, options?: ListRowsOptions): RuntimeOrderBy {
  const first = options?.orderBy?.[0];
  if (!first) return [{ id: 'asc' }];
  if (first.field === 'id') return [{ id: first.direction }];
  if (first.field === 'createdAt') return [{ createdAt: first.direction }, { id: first.direction }];
  if (table === 'events' && first.field === 'sequence') return [{ sequence: first.direction }, { id: first.direction }];
  if (table === 'run_outputs' && first.field === 'ordinal') return [{ ordinal: first.direction }, { id: first.direction }];
  if (table === 'run_outputs' && first.field === 'producedAt') return [{ producedAt: first.direction }, { id: first.direction }];
  return [{ id: 'asc' }];
}

function page(options?: ListRowsOptions): { take: number; skip?: number; cursor?: { id: string } } {
  const take = Math.min(Math.max(options?.first ?? 100, 0), 1000);
  return options?.after ? { take, skip: 1, cursor: { id: options.after } } : { take };
}

const DATA_PATH_FIELDS: Record<RuntimeTable, Record<string, string>> = {
  task_runs: {
    project_id: 'projectId',
    status: 'status',
    pipeline_id: 'pipelineId',
    playbook_id: 'playbookId',
  },
  tasks: {
    run_id: 'runId',
    repo_ref: 'repoRef',
    role_hint: 'roleHint',
    status: 'status',
  },
  events: {
    run_id: 'runId',
    task_id: 'taskId',
    step_id: 'stepId',
    type: 'type',
  },
  attempts: {
    run_id: 'runId',
    step_id: 'stepId',
    idempotency_key: 'idempotencyKey',
    runner_id: 'runnerId',
    provider: 'provider',
    model_id: 'modelId',
    status: 'status',
    verdict: 'verdict',
  },
  inbox: {
    run_id: 'runId',
    task_id: 'taskId',
    step_id: 'stepId',
    project_id: 'projectId',
    kind: 'kind',
    status: 'status',
  },
  cost_ledger: {
    run_id: 'runId',
    step_id: 'stepId',
    attempt_id: 'attemptId',
    runner_id: 'runnerId',
    provider: 'provider',
    model_id: 'modelId',
    currency: 'currency',
  },
  run_outputs: {
    run_id: 'runId',
    node_id: 'nodeId',
    attempt_id: 'attemptId',
    name: 'name',
  },
  steps: {},
};

function prismaFieldForDataPath(table: RuntimeTable, path: string): string | undefined {
  return DATA_PATH_FIELDS[table][path];
}

type RuntimeItem = RuntimeRecord & { id: string; createdAt: Date; updatedAt?: Date | null };

const ROW_MAPPERS: Record<RuntimeModelTable, (item: RuntimeItem) => ControlPlaneRow> = {
  task_runs: taskRunRow,
  tasks: taskRow,
  events: eventRow,
  attempts: attemptRow,
  inbox: inboxRow,
  run_outputs: runOutputRow,
  cost_ledger: costLedgerRow,
};

function modelFor(prisma: RevoPrismaService, table: RuntimeTable): RuntimeModel | null {
  const models: Record<RuntimeModelTable, RuntimeModel> = {
    task_runs: prisma.taskRun as unknown as RuntimeModel,
    tasks: prisma.runTask as unknown as RuntimeModel,
    events: prisma.runEvent as unknown as RuntimeModel,
    attempts: prisma.runAttempt as unknown as RuntimeModel,
    inbox: prisma.inboxItem as unknown as RuntimeModel,
    run_outputs: prisma.runOutput as unknown as RuntimeModel,
    cost_ledger: prisma.costLedgerEntry as unknown as RuntimeModel,
  };
  return table === 'steps' ? null : models[table];
}

function rowFor(table: RuntimeModelTable, item: unknown): ControlPlaneRow {
  return ROW_MAPPERS[table](item as RuntimeItem);
}

function applyIdWhere(where: RowWhereInput, baseWhere: RuntimeRecord): void {
  const ids = whereId(where);
  if (ids.equals) baseWhere.id = ids.equals;
  if (ids.in) baseWhere.id = { in: ids.in };
}

function dataPathPredicate(data: RowWhereInput['data']): string | { in: string[] } | null {
  let predicate: string | { in: string[] } | null = null;

  if (data?.equals !== undefined) {
    if (typeof data.equals !== 'string') return null;
    predicate = data.equals;
  }

  if (data?.in !== undefined) {
    const values = stringValues(data.in);
    if (values.length === 0) return null;
    predicate = { in: values };
  }

  return predicate;
}

function applyDataWhere(table: RuntimeTable, data: RowWhereInput['data'], baseWhere: RuntimeRecord): boolean {
  const path = data?.path;
  if (path === undefined) return true;
  if (typeof path !== 'string') return false;

  const field = prismaFieldForDataPath(table, path);
  const predicate = dataPathPredicate(data);
  if (!field || predicate === null) return false;

  baseWhere[field] = predicate;
  return true;
}

function applyAndWhere(table: RuntimeTable, and: RowWhereInput['AND'], baseWhere: RuntimeRecord): boolean {
  const entries = Array.isArray(and) ? and : [];
  return entries.every((entry) => applyWhere(table, entry, baseWhere));
}

function applyWhere(table: RuntimeTable, where: RowWhereInput | undefined, baseWhere: RuntimeRecord): boolean {
  if (!where) return true;
  if (where.OR !== undefined || where.NOT !== undefined) return false;

  applyIdWhere(where, baseWhere);
  return applyDataWhere(table, where.data, baseWhere) && applyAndWhere(table, where.AND, baseWhere);
}

function whereForList(table: RuntimeTable, options?: ListRowsOptions): RuntimeRecord | null {
  const baseWhere: RuntimeRecord = {};
  return applyWhere(table, options?.where, baseWhere) ? baseWhere : null;
}

async function emitChange(table: RuntimeTable, action: 'create' | 'update' | 'patch', rowId: string, item: ControlPlaneRow): Promise<void> {
  await notifyControlPlaneChange({ table, action, rowId, row: item });
}

function taskRunRow(item: RuntimeItem): ControlPlaneRow {
  return row('task_runs', item.id, {
    id: item.id,
    project_id: item.projectId ?? '',
    title: item.title,
    description: item.description,
    status: item.status,
    repos: item.repos,
    scope: item.scope,
    priority: item.priority,
    playbook_id: item.playbookId,
    pipeline_id: item.pipelineId,
    params: item.params,
    route_decision: item.routeDecision,
    created_by: item.createdBy,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt?.toISOString() ?? item.createdAt.toISOString(),
  }, item.createdAt, item.updatedAt ?? item.createdAt);
}

function taskRow(item: RuntimeItem): ControlPlaneRow {
  return row('tasks', item.id, {
    id: item.id,
    run_id: item.runId,
    repo_ref: item.repoRef,
    role_hint: item.roleHint,
    title: item.title,
    status: item.status,
    depends_on: item.dependsOn,
    scope: item.scope,
    priority: item.priority,
    created_at: item.createdAt.toISOString(),
    updated_at: item.updatedAt?.toISOString() ?? item.createdAt.toISOString(),
  }, item.createdAt, item.updatedAt ?? item.createdAt);
}

function eventRow(item: RuntimeItem): ControlPlaneRow {
  return row('events', item.id, {
    id: item.id,
    run_id: item.runId,
    sequence: item.sequence,
    task_id: item.taskId,
    step_id: item.stepId,
    type: item.type,
    payload: item.payload,
    actor: item.actor,
    created_at: item.createdAt.toISOString(),
  }, item.createdAt);
}

function attemptRow(item: RuntimeItem): ControlPlaneRow {
  return row('attempts', item.id, {
    id: item.id,
    step_id: item.stepId,
    run_id: item.runId,
    worker_id: item.workerId,
    attempt_no: item.attemptNo,
    iteration: item.iteration,
    status: item.status,
    idempotency_key: item.idempotencyKey,
    runner_id: requiredProvenance(item.runnerId, 'runner_id'),
    provider: requiredProvenance(item.provider, 'provider'),
    model_id: requiredProvenance(item.modelId, 'model_id'),
    verdict: item.verdict,
    input_tokens: nullableInt(item.inputTokens),
    output_tokens: nullableInt(item.outputTokens),
    cost_amount: nullableDecimalNum(item.costAmount),
    currency: item.currency ?? null,
    duration_ms: item.durationMs,
    output_summary: item.outputSummary,
    artifact_ref: item.artifactRef,
    stdout_tail: item.stdoutTail,
    stderr_tail: item.stderrTail,
    lesson: item.lesson,
    error: item.error,
    started_at: iso(item.startedAt),
    finished_at: iso(item.finishedAt),
  }, item.createdAt, item.updatedAt ?? item.createdAt);
}

function inboxRow(item: RuntimeItem): ControlPlaneRow {
  return row('inbox', item.id, {
    id: item.id,
    kind: item.kind,
    run_id: item.runId ?? '',
    task_id: item.taskId,
    step_id: item.stepId,
    project_id: item.projectId,
    title: item.title,
    context: item.context,
    options: item.options,
    status: item.status,
    answer: item.answer ?? null,
    resolved_by: item.resolvedBy,
    created_at: item.createdAt.toISOString(),
    resolved_at: iso(item.resolvedAt),
  }, item.createdAt, item.updatedAt ?? item.createdAt);
}

function runOutputRow(item: RuntimeItem): ControlPlaneRow {
  return row('run_outputs', item.id, {
    id: item.id,
    run_id: item.runId,
    node_id: item.nodeId,
    ordinal: item.ordinal,
    name: item.name,
    schema_ref: item.schemaRef,
    payload: item.payload,
    payload_ref: item.payloadRef,
    attempt_id: item.attemptId,
    produced_at: iso(item.producedAt),
  }, item.createdAt);
}

function costLedgerRow(item: RuntimeItem): ControlPlaneRow {
  return row('cost_ledger', item.id, {
    id: item.id,
    run_id: item.runId,
    step_id: item.stepId,
    attempt_id: item.attemptId,
    runner_id: requiredProvenance(item.runnerId, 'runner_id'),
    provider: requiredProvenance(item.provider, 'provider'),
    model_id: requiredProvenance(item.modelId, 'model_id'),
    input_tokens: nullableInt(item.inputTokens),
    output_tokens: nullableInt(item.outputTokens),
    cost_amount: nullableDecimalNum(item.costAmount),
    currency: item.currency ?? null,
    recorded_at: iso(item.recordedAt),
  }, item.createdAt);
}

export function createPrismaRuntimeDataAccess(prisma: RevoPrismaService): ControlPlaneDataAccess {
  async function get(table: RuntimeTable, rowId: string): Promise<ControlPlaneRow | null> {
    assertTable(table);
    const model = modelFor(prisma, table);
    if (!model) return null;
    const item = await model.findUnique({ where: { id: rowId } });
    return item ? rowFor(table as RuntimeModelTable, item) : null;
  }

  async function list(table: RuntimeTable, options?: ListRowsOptions): Promise<ControlPlaneRow[]> {
    assertTable(table);
    const model = modelFor(prisma, table);
    if (!model) return [];
    const where = whereForList(table, options);
    if (!where) return [];
    const paging = page(options);
    const items = await model.findMany({
      where,
      orderBy: orderBy(table, options),
      ...paging,
    });
    return items.map((item) => rowFor(table as RuntimeModelTable, item));
  }

  async function create(table: RuntimeTable, rowId: string, data: RuntimeRecord): Promise<ControlPlaneRow> {
    assertTable(table);
    if (table === 'steps') {
      throw new ControlPlaneError('VALIDATION_FAILURE', 'steps runtime table is retired');
    }
    try {
      if (table === 'task_runs') {
        await prisma.taskRun.create({ data: {
          id: rowId,
          projectId: str(data.project_id) || null,
          title: str(data.title),
          description: str(data.description),
          status: str(data.status, 'ready'),
          repos: strArr(data.repos),
          scope: str(data.scope),
          priority: int(data.priority),
          playbookId: str(data.playbook_id),
          pipelineId: str(data.pipeline_id),
          params: json(data.params, {}),
          routeDecision: json(data.route_decision, {}),
          createdBy: str(data.created_by),
          createdAt: dateValue(data.created_at),
          updatedAt: dateValue(data.updated_at),
        } });
      } else if (table === 'tasks') {
        await prisma.runTask.create({ data: {
          id: rowId,
          runId: str(data.run_id),
          repoRef: str(data.repo_ref),
          roleHint: str(data.role_hint),
          title: str(data.title),
          status: str(data.status, 'ready'),
          dependsOn: strArr(data.depends_on),
          scope: str(data.scope),
          priority: int(data.priority),
          createdAt: dateValue(data.created_at),
          updatedAt: dateValue(data.updated_at),
        } });
      } else if (table === 'events') {
        await prisma.runEvent.create({ data: {
          id: rowId,
          runId: str(data.run_id),
          taskId: str(data.task_id),
          stepId: str(data.step_id),
          type: str(data.type),
          payload: json(data.payload, {}),
          actor: str(data.actor),
          createdAt: dateValue(data.created_at),
        } });
      } else if (table === 'attempts') {
        await prisma.runAttempt.create({ data: {
          id: rowId,
          runId: str(data.run_id),
          stepId: str(data.step_id),
          workerId: str(data.worker_id),
          attemptNo: int(data.attempt_no),
          iteration: int(data.iteration),
          status: str(data.status),
          idempotencyKey: str(data.idempotency_key),
          runnerId: requiredProvenance(data.runner_id, 'runner_id'),
          provider: requiredProvenance(data.provider, 'provider'),
          modelId: requiredProvenance(data.model_id, 'model_id'),
          verdict: str(data.verdict),
          inputTokens: nullableInt(data.input_tokens),
          outputTokens: nullableInt(data.output_tokens),
          costAmount: nullableNum(data.cost_amount),
          currency: data.currency === null || data.currency === undefined ? null : str(data.currency),
          durationMs: int(data.duration_ms),
          outputSummary: str(data.output_summary),
          artifactRef: str(data.artifact_ref),
          stdoutTail: str(data.stdout_tail),
          stderrTail: str(data.stderr_tail),
          lesson: str(data.lesson),
          error: str(data.error),
          startedAt: dateValue(data.started_at),
          finishedAt: dateValue(data.finished_at),
        } });
      } else if (table === 'inbox') {
        await prisma.inboxItem.create({ data: {
          id: rowId,
          kind: str(data.kind),
          runId: str(data.run_id) || null,
          taskId: str(data.task_id),
          stepId: str(data.step_id),
          projectId: str(data.project_id),
          title: str(data.title),
          context: json(data.context, {}),
          options: strArr(data.options),
          status: str(data.status, 'pending'),
          answer: data.answer === undefined ? Prisma.JsonNull : json(data.answer, null),
          resolvedBy: str(data.resolved_by),
          createdAt: dateValue(data.created_at),
          resolvedAt: nullableDate(data.resolved_at),
        } });
      } else if (table === 'run_outputs') {
        await prisma.runOutput.create({ data: {
          id: rowId,
          runId: str(data.run_id),
          nodeId: str(data.node_id),
          ordinal: int(data.ordinal),
          name: str(data.name),
          schemaRef: str(data.schema_ref),
          payload: json(data.payload, {}),
          payloadRef: str(data.payload_ref),
          attemptId: str(data.attempt_id),
          producedAt: dateValue(data.produced_at),
        } });
      } else {
        await prisma.costLedgerEntry.create({ data: {
          id: rowId,
          runId: str(data.run_id),
          stepId: str(data.step_id),
          attemptId: str(data.attempt_id),
          runnerId: requiredProvenance(data.runner_id, 'runner_id'),
          provider: requiredProvenance(data.provider, 'provider'),
          modelId: requiredProvenance(data.model_id, 'model_id'),
          inputTokens: nullableInt(data.input_tokens),
          outputTokens: nullableInt(data.output_tokens),
          costAmount: nullableNum(data.cost_amount),
          currency: data.currency === null || data.currency === undefined ? null : str(data.currency),
          recordedAt: dateValue(data.recorded_at),
        } });
      }
      const item = await get(table, rowId);
      if (!item) throw new ControlPlaneError('TRANSPORT_ERROR', `Created row disappeared: ${table}/${rowId}`);
      await emitChange(table, 'create', rowId, item);
      return item;
    } catch (error) {
      if (isConflict(error)) throw new ControlPlaneError('ROW_CONFLICT', `Row already exists: ${table}/${rowId}`);
      throw error;
    }
  }

  async function update(table: RuntimeTable, rowId: string, data: RuntimeRecord, action: 'update' | 'patch' = 'update'): Promise<ControlPlaneRow> {
    const existing = await get(table, rowId);
    if (!existing) throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot update missing row: ${table}/${rowId}`);
    const merged: RuntimeRecord = { ...existing.data, ...data, id: rowId };
    if (table === 'task_runs') {
      await prisma.taskRun.update({ where: { id: rowId }, data: {
        projectId: str(merged.project_id) || null,
        title: str(merged.title),
        description: str(merged.description),
        status: str(merged.status),
        repos: strArr(merged.repos),
        scope: str(merged.scope),
        priority: int(merged.priority),
        playbookId: str(merged.playbook_id),
        pipelineId: str(merged.pipeline_id),
        params: json(merged.params, {}),
        routeDecision: json(merged.route_decision, {}),
        createdBy: str(merged.created_by),
        updatedAt: dateValue(merged.updated_at),
      } });
    } else if (table === 'tasks') {
      await prisma.runTask.update({ where: { id: rowId }, data: {
        runId: str(merged.run_id),
        repoRef: str(merged.repo_ref),
        roleHint: str(merged.role_hint),
        title: str(merged.title),
        status: str(merged.status),
        dependsOn: strArr(merged.depends_on),
        scope: str(merged.scope),
        priority: int(merged.priority),
        updatedAt: dateValue(merged.updated_at),
      } });
    } else if (table === 'inbox') {
      await prisma.inboxItem.update({ where: { id: rowId }, data: {
        kind: str(merged.kind),
        runId: str(merged.run_id) || null,
        taskId: str(merged.task_id),
        stepId: str(merged.step_id),
        projectId: str(merged.project_id),
        title: str(merged.title),
        context: json(merged.context, {}),
        options: strArr(merged.options),
        status: str(merged.status),
        answer: merged.answer === undefined ? Prisma.JsonNull : json(merged.answer, null),
        resolvedBy: str(merged.resolved_by),
        resolvedAt: nullableDate(merged.resolved_at),
      } });
    } else {
      throw new ControlPlaneError('VALIDATION_FAILURE', `Updates are not supported for append-only runtime table: ${table}`);
    }
    const item = await get(table, rowId);
    if (!item) throw new ControlPlaneError('TRANSPORT_ERROR', `Updated row disappeared: ${table}/${rowId}`);
    await emitChange(table, action, rowId, item);
    return item;
  }

  return {
    assertReady: async () => undefined,
    listRows: list,
    getRow: get,
    createRow: create,
    updateRow: update,
    async patchRow(table, rowId, patches) {
      const existing = await get(table, rowId);
      if (!existing) throw new ControlPlaneError('ROW_NOT_FOUND', `Cannot patch missing row: ${table}/${rowId}`);
      return update(table, rowId, applyPatches(existing.data, patches), 'patch');
    },
  };
}
