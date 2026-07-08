
















import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from './data-access.js';
import { ControlPlaneError } from './errors.js';
import type { RowWhereInput } from './query-types.js';
import { compactStamp } from './steps.js';


export type ResolveInboxResult = {

  status: 'pending' | 'resolved';

  answer: unknown;
};

export type InboxKind = 'approval' | 'question' | 'alert';

export type NewInboxItem = {
  kind: InboxKind;
  runId?: string;
  taskId?: string;
  stepId?: string;
  projectId?: string;
  title: string;
  context: unknown;
  options?: string[];
};

export type InboxFilter = {
  status?: 'pending' | 'resolved';
  runId?: string;
  limit?: number;
};

export type InboxItem = {
  id: string;
  kind: InboxKind;
  runId: string;
  taskId: string;
  stepId: string;
  projectId: string;
  title: string;
  context: unknown;
  options: string[];
  status: 'pending' | 'resolved';
  answer: unknown;
  resolvedBy: string;
  createdAt: string;
  resolvedAt: string;
};

const SECRET_PATTERN = /(?:password|secret|token|key|credential|auth|api_key|apikey)/i;

export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return (value as unknown[]).map(redactSecrets);
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = SECRET_PATTERN.test(k) ? '[REDACTED]' : redactSecrets(v);
  }
  return result;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function mapInboxRow(rowId: string, data: Record<string, unknown>): InboxItem {
  return {
    id: rowId,
    kind: str(data.kind) as InboxKind,
    runId: str(data.run_id),
    taskId: str(data.task_id),
    stepId: str(data.step_id),
    projectId: str(data.project_id),
    title: str(data.title),
    context: data.context ?? null,
    options: Array.isArray(data.options) ? (data.options as unknown[]).map(str) : [],
    status: str(data.status) as 'pending' | 'resolved',
    answer: data.answer ?? null,
    resolvedBy: str(data.resolved_by),
    createdAt: str(data.created_at),
    resolvedAt: str(data.resolved_at),
  };
}

















function inboxWhere(filter?: InboxFilter): RowWhereInput | undefined {
  const clauses: RowWhereInput[] = [];
  if (filter?.runId) clauses.push({ data: { path: 'run_id', equals: filter.runId } });
  if (filter?.status) clauses.push({ data: { path: 'status', equals: filter.status } });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : { AND: clauses };
}

export async function pushInbox(
  da: ControlPlaneDataAccess,
  item: NewInboxItem,
  opts?: { now?: Date; idSuffix?: string; id?: string },
): Promise<string> {
  await da.assertReady();

  let id: string;
  let now: Date;
  if (opts?.id === undefined) {
    now = opts?.now ?? new Date();
    const suffix = opts?.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8);
    id = `inbox_${compactStamp(now)}_${suffix}`;
  } else {
    id = opts.id;
    now = opts?.now ?? new Date();
  }
  const safeContext = redactSecrets(item.context);

  try {
    await da.createRow('inbox', id, {
      id,
      kind: item.kind,
      run_id: item.runId ?? '',
      task_id: item.taskId ?? '',
      step_id: item.stepId ?? '',
      project_id: item.projectId ?? '',
      title: item.title,
      context: safeContext,
      options: item.options ?? [],
      status: 'pending',
      answer: null,
      resolved_by: '',
      resolved_at: '',
      created_at: now.toISOString(),
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return id;
    throw e;
  }

  return id;
}

export async function listInbox(
  da: ControlPlaneDataAccess,
  filter?: InboxFilter,
): Promise<InboxItem[]> {
  await da.assertReady();
  const rows = await da.listRows('inbox', {
    first: filter?.limit ?? 500,
    where: inboxWhere(filter),
  });
  return rows.map((row) => mapInboxRow(row.rowId, row.data));
}



export async function getInbox(
  da: ControlPlaneDataAccess,
  id: string,
): Promise<InboxItem | null> {
  await da.assertReady();
  const row = await da.getRow('inbox', id);
  if (!row) return null;
  return mapInboxRow(row.rowId, row.data);
}





















export async function resolveInbox(
  da: ControlPlaneDataAccess,
  itemId: string,
  answer: unknown,
  resolvedBy: string,
  opts?: { now?: Date },
): Promise<ResolveInboxResult> {
  await da.assertReady();

  const inbox = await da.getRow('inbox', itemId);
  if (!inbox) {
    throw new ControlPlaneError('ROW_NOT_FOUND', `inbox item not found: ${itemId}`);
  }

  const status = inbox.data.status;
  if (status !== 'pending' && status !== 'resolved') {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `inbox ${itemId} cannot be resolved from status '${String(status)}'`,
    );
  }

  const now = opts?.now ?? new Date();

  if (status === 'pending') {
    await da.patchRow('inbox', itemId, [
      { op: 'replace', path: 'status', value: 'resolved' },
      { op: 'replace', path: 'answer', value: answer },
      { op: 'replace', path: 'resolved_by', value: resolvedBy },
      { op: 'replace', path: 'resolved_at', value: now.toISOString() },
    ]);
  }

  const resolvedInbox = status === 'pending' ? await da.getRow('inbox', itemId) : inbox;
  const effectiveAnswer = resolvedInbox?.data.answer ?? answer;

  return { status, answer: effectiveAnswer };
}
