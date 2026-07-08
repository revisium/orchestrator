
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
  return { data: { path: 'run_id', equals: runId } };
}

function whereRunNode(runId: string, nodeId: string): ListRowsOptions['where'] {
  return {
    AND: [
      { data: { path: 'run_id', equals: runId } },
      { data: { path: 'node_id', equals: nodeId } },
    ],
  };
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

async function listAllOutputRows(
  da: ControlPlaneDataAccess,
  options: Omit<ListRowsOptions, 'first' | 'after'>,
): Promise<Awaited<ReturnType<ControlPlaneDataAccess['listRows']>>> {
  const rows: Awaited<ReturnType<ControlPlaneDataAccess['listRows']>> = [];
  let after: string | undefined;
  for (;;) {
    const page = await da.listRows('run_outputs', {
      ...options,
      first: 1000,
      after,
    });
    rows.push(...page);
    if (page.length < 1000) break;
    after = page.at(-1)?.cursor;
    if (!after) break;
  }
  return rows;
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
  const rows = await listAllOutputRows(da, {
    where: whereRunNode(runId, nodeId),
    orderBy: [{ field: 'ordinal', direction: 'asc' }],
  });
  return rows.map((r) => rowToOutput(r.data));
}

export async function latestRunOutput(
  da: ControlPlaneDataAccess,
  runId: string,
  nodeId: string,
): Promise<RunOutputRow | null> {
  const rows = await da.listRows('run_outputs', {
    first: 1,
    where: whereRunNode(runId, nodeId),
    orderBy: [{ field: 'ordinal', direction: 'desc' }],
  });
  return rows[0] ? rowToOutput(rows[0].data) : null;
}

export async function outputsForRun(da: ControlPlaneDataAccess, runId: string): Promise<RunOutputRow[]> {
  const rows = await listAllOutputRows(da, {
    where: whereRun(runId),
    orderBy: [{ field: 'producedAt', direction: 'asc' }],
  });
  return rows.map((r) => rowToOutput(r.data));
}
