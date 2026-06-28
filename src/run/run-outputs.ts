








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


const PAYLOAD_MAX = 16_000;





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


export async function latestRunOutput(
  da: ControlPlaneDataAccess,
  runId: string,
  nodeId: string,
): Promise<RunOutputRow | null> {
  const rows = await allRunOutputs(da, runId, nodeId);
  return rows.length ? rows[rows.length - 1] : null;
}


export async function outputsForRun(da: ControlPlaneDataAccess, runId: string): Promise<RunOutputRow[]> {
  const rows = await da.listRows('run_outputs', {
    first: 1000,
    where: whereRun(runId),
  });
  return rows
    .map((r) => rowToOutput(r.data))
    .sort((a, b) => (a.producedAt ?? '').localeCompare(b.producedAt ?? ''));
}
