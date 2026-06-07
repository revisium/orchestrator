/**
 * inbox.ts — PURE Revisium-table inbox verbs. NO DBOS imports anywhere in this file.
 *
 * Covers: pushInbox, listInbox, getInbox, resolveInbox.
 *
 * RESUMABILITY guarantee (G9): resolveInbox COMPLETES idempotently on every call.
 * A crash between the inbox patch and the step patch is repaired by a retry — the
 * retry re-reads the already-resolved inbox row, takes the stored answer (stored
 * answer wins; first resolver is authoritative), and idempotently drives the step
 * from awaiting_approval → ready. Calling resolveInbox twice converges to:
 *   inbox resolved + step unblocked exactly once.
 *
 * KNOWN LIMITATION (G5 residual): data-access.ts patchRow is a plain write — no
 * CAS. Two truly-concurrent first-time resolvers can both pass the `pending` read
 * before either writes, and both proceed (each re-flips the step — harmless
 * idempotent duplicate writes, but no CAS prevents dual entry). In practice the
 * inbox has a single human resolver, so this is acceptable for 0002. A full
 * conditional pending→resolved transition is a data-access-seam enhancement
 * (add CAS/conditional write to data-access.ts) and is out of scope for 0002.
 * Do NOT "fix" this by adding DBOS or hand-rolling a lock.
 */

import { randomUUID } from 'node:crypto';
import type { ControlPlaneDataAccess } from './data-access.js';
import { ControlPlaneError } from './errors.js';
import { compactStamp } from './steps.js'; // NOT from ./index.js — compactStamp is not re-exported there

// ─── domain types ────────────────────────────────────────────

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

// ─── secret redaction ────────────────────────────────────────

const SECRET_PATTERN = /(?:password|secret|token|key|credential|auth|api_key|apikey)/i;

/**
 * Recursively strip obvious secret-shaped keys from a value before persisting.
 * - Plain objects: redact matching keys at ANY depth, recurse into non-secret values.
 * - Arrays: recurse into each element.
 * - Primitives / null: return as-is.
 * Full policy can firm up later; this covers the common cases.
 */
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

// ─── row mapping ─────────────────────────────────────────────

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

// ─── exported verbs ──────────────────────────────────────────

/**
 * pushInbox — insert an inbox row; set the originating step to awaiting_approval
 * (branch stops, siblings continue). Returns the inbox id.
 *
 * G10: seeds answer: null, resolved_by: '', resolved_at: '' so that the resolveInbox
 * `replace` patches hit present paths (serializeData omits undefined fields, leaving
 * absent paths that Revisium's patch handler rejects for `replace`).
 *
 * Redacts secrets in context before writing (contract line 163).
 */
export async function pushInbox(
  da: ControlPlaneDataAccess,
  item: NewInboxItem,
  opts?: { now?: Date; idSuffix?: string },
): Promise<string> {
  await da.assertReady();
  const now = opts?.now ?? new Date();
  const suffix = opts?.idSuffix ?? randomUUID().replaceAll('-', '').slice(0, 8);
  const id = `inbox_${compactStamp(now)}_${suffix}`;
  const safeContext = redactSecrets(item.context);

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
    // G10 — seed every later-patched optional column as a present value (never undefined).
    // serializeData (json-fields.ts:38) omits undefined fields; an absent path causes
    // Revisium's patch handler to reject a replace → resolveInbox patches would fail.
    // answer: null is serialized by json-fields as JSON null → 'null' string on the JSON field.
    answer: null,
    resolved_by: '',
    resolved_at: '',
    created_at: now.toISOString(),
  });

  // Park the originating step (bare path — G6):
  if (item.stepId) {
    await da.patchRow('steps', item.stepId, [
      { op: 'replace', path: 'status', value: 'awaiting_approval' },
    ]);
  }

  return id;
}

/**
 * listInbox — read the inbox table, optionally filtered.
 * Draft read; consumers never see Revisium types (returns InboxItem[]).
 */
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
 * getInbox — read a single inbox row.
 * G12: intentionally returns InboxItem | null (maps da.getRow's null-on-missing path),
 * superseding repo-layer-contract.md:172's non-null signature. Null is the safer shape.
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
 * resolveInbox — pure status flip + step unblock. NO DBOS signal (that is 0004).
 *
 * RESUMABLE + idempotent (G9): COMPLETES on every call.
 *   - If inbox is pending: patch to resolved, then unblock the step.
 *   - If inbox is already resolved (retry / double-resolve): skip the inbox re-patch
 *     (stored answer wins), but STILL drive the step unblock from the stored answer.
 *   - This means a crash between the inbox patch and the step patch is repaired by a
 *     retry — the parked step is NEVER left stuck.
 *
 * CURRENT-STATE-SAFE (G5):
 *   - pending → resolved only (else VALIDATION_FAILURE).
 *   - Resurrection guard: if the step is no longer awaiting_approval (cancelled /
 *     re-driven / gone), console.warn and skip the step flip without throwing.
 *   - Deterministic continuation: step_cont_${itemId} so a re-run collides on the
 *     same id rather than creating a duplicate.
 *
 * KNOWN LIMITATION: no CAS (see module doc-comment above).
 */
export async function resolveInbox(
  da: ControlPlaneDataAccess,
  itemId: string,
  answer: unknown,
  resolvedBy: string,
  opts?: { now?: Date },
): Promise<void> {
  await da.assertReady();

  // (1) READ. getRow returns null for a missing inbox row.
  const inbox = await da.getRow('inbox', itemId);
  if (!inbox) {
    throw new ControlPlaneError('ROW_NOT_FOUND', `inbox item not found: ${itemId}`);
  }

  // (2) STATE GUARD. Only pending or resolved are valid states to act on.
  const status = inbox.data.status;
  if (status !== 'pending' && status !== 'resolved') {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `inbox ${itemId} cannot be resolved from status '${String(status)}'`,
    );
  }

  const now = opts?.now ?? new Date();

  // (3) IDEMPOTENT INBOX WRITE.
  //   pending  → patch to resolved carrying answer / resolved_by / resolved_at.
  //   resolved → SKIP the re-patch. The stored answer wins (first resolver is authoritative).
  if (status === 'pending') {
    await da.patchRow('inbox', itemId, [
      { op: 'replace', path: 'status', value: 'resolved' },       // BARE paths (G6)
      { op: 'replace', path: 'answer', value: answer },
      { op: 'replace', path: 'resolved_by', value: resolvedBy },
      { op: 'replace', path: 'resolved_at', value: now.toISOString() },
    ]);
  }

  // The effective answer for the step unblock: stored wins on a re-call.
  const effectiveAnswer = status === 'resolved' ? inbox.data.answer : answer;

  // (4) ALWAYS-RUN STEP COMPLETION (the resumable part).
  // Runs on every call once inbox is known-resolved.
  const stepId = typeof inbox.data.step_id === 'string' ? inbox.data.step_id : '';
  if (!stepId) return; // alert-kind / step-less item: inbox flip is the whole resolve.

  // Re-read the originating step and idempotently complete the unblock.
  const step = await da.getRow('steps', stepId);
  if (step && step.data.status === 'awaiting_approval') {
    // Still parked → flip to ready carrying the stored answer. Bare paths (G6).
    await da.patchRow('steps', stepId, [
      { op: 'replace', path: 'status', value: 'ready' },
      { op: 'replace', path: 'input', value: effectiveAnswer },
    ]);
    return;
  }

  // step already ready (done state) → clean NO-OP (no warn, no duplicate).
  if (step && step.data.status === 'ready') {
    return;
  }

  // step is null OR in an unexpected state (cancelled / re-driven / superseded) →
  // RESURRECTION GUARD: do NOT flip it. Leave the inbox resolved and console.warn.
  console.warn(`resolveInbox: step ${stepId} no longer awaiting_approval; skipping unblock`);
}
