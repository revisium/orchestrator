/**
 * run-outputs.ts — step-output dataflow rows.
 *
 * Each node EXECUTION appends one immutable `run_outputs` row keyed by (runId, nodeId, ordinal). The
 * rows are APPEND-ONLY → full history for retro/audit; the adapter reads `latest`/`all` to hydrate a
 * consumer's prompt. The `ordinal` is the adapter-owned per-(run,node) execution count
 * — NOT a row-scan, NOT the routing loop counter.
 *
 * Mirrors append-event.ts: a DETERMINISTIC + bounded row id (fnv1a64Hex), a secret-redacted +
 * size-capped payload, and a ROW_CONFLICT no-op so a DBOS replay re-writing the same id is idempotent.
 */
import type { ControlPlaneDataAccess, ListRowsOptions } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { redactSecrets } from '../control-plane/inbox.js';
import { redactTokens } from '../runners/gh-identity.js';
import { redactEventPayload } from './append-event.js';

export type RunOutputRow = {
  runId: string;
  nodeId: string;
  ordinal: number;
  name: string;
  schemaRef: string;
  payload: unknown;
  attemptId?: string;
  producedAt?: string;
};

/** Cap the serialized payload so a giant agent output can't bloat the row (cf. attempts 4k). */
const PAYLOAD_MAX = 16_000;

/**
 * `where` clause filtering on the scalar `run_id` column. The Revisium JSON filter `equals` is typed as
 * an object map but accepts a scalar; we cast the whole clause (via the data-access alias, NOT
 * `@revisium/client` — that import is restricted to the control-plane layer + the build-context legacy
 * exception, see the Invariant #4 guard).
 */
function whereRun(runId: string): ListRowsOptions['where'] {
  return { data: { path: 'run_id', equals: runId } } as unknown as ListRowsOptions['where'];
}

function rowToOutput(data: Record<string, unknown>): RunOutputRow {
  return {
    runId: String(data.run_id ?? ''),
    nodeId: String(data.node_id ?? ''),
    ordinal: Number(data.ordinal ?? 0),
    name: String(data.name ?? ''),
    schemaRef: String(data.schema_ref ?? ''),
    payload: data.payload,
    attemptId: data.attempt_id ? String(data.attempt_id) : undefined,
    producedAt: data.produced_at ? String(data.produced_at) : undefined,
  };
}

/**
 * Append one immutable step-output row.
 *
 * id = `out_${fnv1a64Hex(`${runId}|${nodeId}|${ordinal}`)}` → 20 chars ≤ 64.
 *
 * Idempotent: a DBOS replay re-derives the same id (the ordinal is adapter-owned + replay-deterministic);
 * ROW_CONFLICT is a no-op. The payload is a JSON field — secrets are redacted on every
 * string leaf before persist; an over-cap payload is replaced by a marker + a `payload_ref`.
 */
export async function appendRunOutput(da: ControlPlaneDataAccess, input: RunOutputRow): Promise<void> {
  const id = `out_${fnv1a64Hex(`${input.runId}|${input.nodeId}|${input.ordinal}`)}`;
  const redacted = redactEventPayload(redactSecrets(input.payload) ?? null);
  const overCap = redactTokens(JSON.stringify(redacted ?? null)).length > PAYLOAD_MAX;
  try {
    await da.createRow('run_outputs', id, {
      id,
      run_id: input.runId,
      node_id: input.nodeId,
      ordinal: input.ordinal,
      name: input.name,
      schema_ref: input.schemaRef,
      payload: overCap ? { _truncated: true } : redacted,
      payload_ref: overCap ? `attempt:${input.attemptId ?? ''}` : '',
      attempt_id: input.attemptId ?? '',
      produced_at: (input.producedAt ? new Date(input.producedAt) : new Date()).toISOString(),
    });
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'ROW_CONFLICT') return;
    throw e;
  }
}

/** Every output row for a (runId, nodeId), ordinal-ascending (loop history). */
export async function allRunOutputs(
  da: ControlPlaneDataAccess,
  runId: string,
  nodeId: string,
): Promise<RunOutputRow[]> {
  const rows = await da.listRows('run_outputs', {
    first: 1000,
    where: whereRun(runId),
  });
  return rows
    .map((r) => rowToOutput(r.data))
    .filter((o) => o.nodeId === nodeId)
    .sort((a, b) => a.ordinal - b.ordinal);
}

/** The most recent output for a (runId, nodeId) = max(ordinal); null when none exists. */
export async function latestRunOutput(
  da: ControlPlaneDataAccess,
  runId: string,
  nodeId: string,
): Promise<RunOutputRow | null> {
  const rows = await allRunOutputs(da, runId, nodeId);
  return rows.length ? rows[rows.length - 1] : null;
}

/** Every output row for a run, produced_at-ascending — the retro/audit view. */
export async function outputsForRun(da: ControlPlaneDataAccess, runId: string): Promise<RunOutputRow[]> {
  const rows = await da.listRows('run_outputs', {
    first: 1000,
    where: whereRun(runId),
  });
  return rows
    .map((r) => rowToOutput(r.data))
    .sort((a, b) => (a.producedAt ?? '').localeCompare(b.producedAt ?? ''));
}
