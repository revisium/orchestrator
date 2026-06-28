/**
 * inbox.ts — PURE Revisium-table inbox verbs. NO DBOS imports anywhere in this file.
 *
 * RESUMABILITY: resolveInbox COMPLETES idempotently on every call. A crash between the
 * inbox patch and the step patch is repaired by a retry — the retry re-reads the
 * already-resolved inbox row, takes the stored answer (stored answer wins; first
 * resolver is authoritative), and idempotently drives the step from awaiting_approval
 * → ready. Calling resolveInbox twice converges to: inbox resolved + step unblocked
 * exactly once.
 *
 * KNOWN LIMITATION: data-access.ts patchRow is a plain write — no CAS. Two
 * truly-concurrent first-time resolvers can both pass the `pending` read before either
 * writes, and both proceed (each re-flips the step — harmless idempotent duplicate
 * writes, but no CAS prevents dual entry). In practice the inbox has a single human
 * resolver, so this is acceptable. A full conditional pending→resolved transition is a
 * data-access-seam enhancement (add CAS/conditional write to data-access.ts) and is
 * out of scope. Do NOT "fix" this by adding DBOS or hand-rolling a lock.
 */

import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from './data-access.js';
import { ControlPlaneError } from './errors.js';
import { compactStamp } from './steps.js'; // NOT from ./index.js — compactStamp is not re-exported there

/** Carries the STORED decision so callers signal what is recorded, never their raw argument. */
export type ResolveInboxResult = {
  /** Status of the inbox row BEFORE this call (pending ⇒ just resolved; resolved ⇒ already was). */
  status: 'pending' | 'resolved';
  /** Effective stored answer (first-resolver wins; retry gets the STORED value, not its arg). */
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

/**
 * pushInbox — seeds the optional columns (answer, resolved_by, resolved_at) as present
 * values so the resolveInbox `replace` patches hit present paths (serializeData omits
 * undefined fields, leaving absent paths Revisium's patch handler rejects for `replace`).
 *
 * Idempotent on workflow-body replay: wraps createRow in a ROW_CONFLICT catch. On replay
 * the row already exists → swallows the conflict and returns the same id (no duplicate).
 * Gate rows carry no stepId, so the step-park branch is moot on ROW_CONFLICT; we return
 * before it.
 *
 * Deterministic path (opts.id present): the id is used VERBATIM (bypassing
 * compactStamp+suffix) and NO non-deterministic value is computed until inside the insert
 * — at which point ROW_CONFLICT makes the row exactly-once (first write wins; any replayed
 * new Date() is discarded and never persisted). Only the legacy path (no opts.id) computes
 * `now` up front, because there it is part of the id.
 *
 * Redacts secrets in context before writing.
 */
export async function pushInbox(
  da: ControlPlaneDataAccess,
  item: NewInboxItem,
  opts?: { now?: Date; idSuffix?: string; id?: string },
): Promise<string> {
  await da.assertReady();

  let id: string;
  let now: Date;
  if (opts?.id === undefined) {
    // Legacy path: timestamp is part of the id — must be computed before createRow.
    now = opts?.now ?? new Date();
    const suffix = opts?.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8);
    id = `inbox_${compactStamp(now)}_${suffix}`;
  } else {
    // Deterministic gate path: id is caller-supplied verbatim; timestamp is only needed
    // for created_at in the insert — evaluated lazily inside the try block below.
    id = opts.id;
    // Use opts.now if provided (test-seeded), otherwise defer new Date() to the insert.
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
      // Seed every later-patched optional column as a present value (never undefined):
      // serializeData omits undefined fields, and an absent path makes Revisium's patch
      // handler reject a replace → resolveInbox patches would fail. answer: null serializes
      // as JSON null.
      answer: null,
      resolved_by: '',
      resolved_at: '',
      created_at: now.toISOString(),
    });
  } catch (e) {
    // Idempotent on workflow-body replay: same row already exists → no-op.
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return id;
    throw e;
  }

  // No `steps` row is parked: the data-driven engine carries no inbox stepId (await-human
  // sets ''), so the legacy step-park is dead. The DBOS workflow is parked by DBOS.recv.
  return id;
}

export async function listInbox(
  da: ControlPlaneDataAccess,
  filter?: InboxFilter,
): Promise<InboxItem[]> {
  await da.assertReady();
  const rows = await da.listRows('inbox', { first: filter?.limit ?? 500 });
  let items = rows.map((row) => mapInboxRow(row.rowId, row.data));
  if (filter?.status) items = items.filter((i) => i.status === filter.status);
  if (filter?.runId) items = items.filter((i) => i.runId === filter.runId);
  return items;
}

/**
 * Intentionally returns InboxItem | null (maps getRow's null-on-missing path); null is
 * the safer shape.
 */
export async function getInbox(
  da: ControlPlaneDataAccess,
  id: string,
): Promise<InboxItem | null> {
  await da.assertReady();
  const row = await da.getRow('inbox', id);
  if (!row) return null;
  return mapInboxRow(row.rowId, row.data);
}

/**
 * resolveInbox — pure status flip. NO DBOS signal; the parked workflow resumes via DBOS.send.
 *
 * Returns the STORED decision { status, answer } so the caller signals WHAT IS RECORDED,
 * never the raw flag passed to this call:
 *   - status: the row's status BEFORE this call ('pending' ⇒ just resolved; 'resolved' ⇒ already was).
 *   - answer: the EFFECTIVE stored answer (first-resolver wins; retry returns stored, not its arg).
 *
 * RESUMABLE + idempotent: COMPLETES on every call.
 *   - pending: patch to resolved, then unblock the step.
 *   - already resolved (retry / double-resolve): skip the inbox re-patch (stored answer wins),
 *     but STILL drive the step unblock from the stored answer.
 *   - A crash between the inbox patch and the step patch is repaired by a retry — the parked
 *     step is NEVER left stuck.
 *
 * pending → resolved only (else VALIDATION_FAILURE). Resurrection guard: if the step is no
 * longer awaiting_approval (cancelled / re-driven / gone), warn and skip the step flip
 * without throwing. Continuation id is deterministic (step_cont_${itemId}) so a re-run
 * collides rather than creating a duplicate.
 *
 * KNOWN LIMITATION: no CAS (see module doc-comment above).
 */
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

  // Idempotent inbox write: pending → patch to resolved; resolved → SKIP the re-patch
  // (stored answer wins; first resolver is authoritative).
  if (status === 'pending') {
    await da.patchRow('inbox', itemId, [
      { op: 'replace', path: 'status', value: 'resolved' },
      { op: 'replace', path: 'answer', value: answer },
      { op: 'replace', path: 'resolved_by', value: resolvedBy },
      { op: 'replace', path: 'resolved_at', value: now.toISOString() },
    ]);
  }

  // The effective answer is ALWAYS the STORED (persisted) value — re-read from the row.
  // On the already-resolved path the pre-read row carries it; on the first-resolve path we
  // re-read after patching so we return what is durably recorded (guards against JSON-field
  // round-trip canonicalization and concurrent resolvers). Both paths converge to: signal
  // what is recorded, never the raw caller argument.
  const resolvedInbox = status === 'pending' ? await da.getRow('inbox', itemId) : inbox;
  const effectiveAnswer = resolvedInbox?.data.answer ?? answer;

  // The data-driven engine carries no inbox stepId, so there is no originating `steps` row
  // to unblock — the parked DBOS workflow resumes via DBOS.send on the signalled topic.
  return { status, answer: effectiveAnswer };
}
