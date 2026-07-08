/**
 * run-outputs.test.ts — unit tests for the step-output dataflow store (plan 0016 phase 2).
 *
 * Verifies: deterministic bounded id; secret/token redaction at the persist boundary; ROW_CONFLICT
 * idempotency on replay; latest = max(ordinal); all = ordinal-ascending; outputsForRun = produced_at
 * order; an over-cap payload is replaced by a marker + payload_ref.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRunOutput, allRunOutputs, latestRunOutput, outputsForRun } from './run-outputs.js';
import type { ControlPlaneDataAccess, ListRowsOptions } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

type FakeRow = { rowId: string; data: Record<string, unknown> };

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, data);
}

function matchesWhere(row: FakeRow, where: ListRowsOptions['where']): boolean {
  if (!where) return true;
  if (where.id?.equals !== undefined && row.rowId !== where.id.equals) return false;
  if (where.id?.in !== undefined && !where.id.in.includes(row.rowId)) return false;
  if (where.data?.path !== undefined && where.data.equals !== undefined && valueAtPath(row.data, where.data.path) !== where.data.equals) return false;
  if (where.data?.path !== undefined && where.data.in !== undefined && !where.data.in.includes(valueAtPath(row.data, where.data.path))) return false;
  if (where.AND?.some((item) => !matchesWhere(row, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(row, item))) return false;
  const not = where.NOT;
  if (Array.isArray(not) && not.some((item) => matchesWhere(row, item))) return false;
  if (not && !Array.isArray(not) && matchesWhere(row, not)) return false;
  return true;
}

type TestOrderBy = NonNullable<ListRowsOptions['orderBy']>[number];

function compareRows(orderBy: TestOrderBy, a: FakeRow, b: FakeRow): number {
  const field = orderBy.field;
  if (field === 'id') return a.rowId.localeCompare(b.rowId);
  if (field === 'ordinal') return Number(a.data.ordinal ?? 0) - Number(b.data.ordinal ?? 0);
  if (field === 'producedAt') return String(a.data.produced_at ?? '').localeCompare(String(b.data.produced_at ?? ''));
  if (field === 'updatedAt') return String(a.data.updated_at ?? '').localeCompare(String(b.data.updated_at ?? ''));
  return String(a.data.created_at ?? '').localeCompare(String(b.data.created_at ?? ''));
}

function makeFakeDa(opts: { throwConflict?: boolean } = {}): {
  da: ControlPlaneDataAccess;
  rows: FakeRow[];
  listRowsArgs: Array<[string, ListRowsOptions | undefined]>;
} {
  const rows: FakeRow[] = [];
  const listRowsArgs: Array<[string, ListRowsOptions | undefined]> = [];
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async (table, options) => {
      listRowsArgs.push([table, options]);
      let selected = rows.filter((row) => matchesWhere(row, options?.where));
      for (const orderBy of [...(options?.orderBy ?? [])].reverse()) {
        const direction = orderBy.direction === 'desc' ? -1 : 1;
        selected = [...selected].sort((left, right) => compareRows(orderBy, left, right) * direction);
      }
      const afterIndex = options?.after ? selected.findIndex((row) => row.rowId === options.after) : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      const take = options?.first ?? selected.length;
      return selected.slice(start, start + take).map((r) => ({ rowId: r.rowId, data: r.data, cursor: r.rowId }));
    },
    getRow: async () => null,
    createRow: async (_table, rowId, data) => {
      if (opts.throwConflict) throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      rows.push({ rowId, data });
      return { rowId, data };
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId) => ({ rowId, data: {} }),
  };
  return { da, rows, listRowsArgs };
}

const MAX_RUN_ID = 'r'.repeat(64);

test('appendRunOutput: deterministic bounded id (out_ + ≤64) and same inputs → same id', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: MAX_RUN_ID, nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: 'schema:plan', payload: { ok: true } });
  await appendRunOutput(a.da, { runId: MAX_RUN_ID, nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: 'schema:plan', payload: { ok: true } });
  assert.ok(a.rows[0].rowId.startsWith('out_'));
  assert.ok(a.rows[0].rowId.length <= 64);
  assert.equal(a.rows[0].rowId, a.rows[1].rowId, 'same (run,node,ordinal) → same id');
});

test('appendRunOutput: a different ordinal yields a different id', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {} });
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 2, name: 'change', schemaRef: '', payload: {} });
  assert.notEqual(a.rows[0].rowId, a.rows[1].rowId);
});

test('appendRunOutput: redacts a github token from the payload', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, {
    runId: 'run1',
    nodeId: 'analyst',
    ordinal: 1,
    name: 'plan',
    schemaRef: 'schema:plan',
    payload: { note: 'token ghp_0123456789012345678901234567890123 here' },
  });
  const stored = JSON.stringify(a.rows[0].data.payload);
  assert.ok(!stored.includes('ghp_0123456789012345678901234567890123'), 'raw token must not be persisted');
});

test('appendRunOutput: persists the attempt_id for the winning physical attempt', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, {
    runId: 'run1',
    nodeId: 'developer',
    ordinal: 1,
    name: 'change',
    schemaRef: 'schema:change',
    payload: { ok: true },
    attemptId: 'attempt_winner',
  });
  assert.equal(a.rows[0].data.attempt_id, 'attempt_winner');
});


test('appendRunOutput: ROW_CONFLICT on replay is a no-op (idempotent)', async () => {
  const a = makeFakeDa({ throwConflict: true });
  await assert.doesNotReject(() =>
    appendRunOutput(a.da, { runId: 'run1', nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: '', payload: {} }),
  );
});

test('latestRunOutput: returns the max-ordinal row', async () => {
  const a = makeFakeDa();
  for (const ordinal of [1, 2, 3]) {
    await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal, name: 'change', schemaRef: '', payload: { ordinal } });
  }
  const latest = await latestRunOutput(a.da, 'run1', 'dev');
  assert.equal(latest?.ordinal, 3);
  assert.deepEqual(latest?.payload, { ordinal: 3 });
});

test('latestRunOutput: reads one run/node row ordered by ordinal descending', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {} });

  await latestRunOutput(a.da, 'run1', 'dev');

  assert.deepEqual(a.listRowsArgs.at(-1), [
    'run_outputs',
    {
      first: 1,
      where: {
        AND: [
          { data: { path: 'run_id', equals: 'run1' } },
          { data: { path: 'node_id', equals: 'dev' } },
        ],
      },
      orderBy: [{ field: 'ordinal', direction: 'desc' }],
    },
  ]);
});

test('allRunOutputs: returns rows ordinal-ascending (loop history)', async () => {
  const a = makeFakeDa();
  for (const ordinal of [2, 1, 3]) {
    await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal, name: 'change', schemaRef: '', payload: {} });
  }
  const all = await allRunOutputs(a.da, 'run1', 'dev');
  assert.deepEqual(all.map((o) => o.ordinal), [1, 2, 3]);
});

test('allRunOutputs: pushes run/node filters and ordinal ordering into storage', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {} });

  await allRunOutputs(a.da, 'run1', 'dev');

  assert.deepEqual(a.listRowsArgs.at(-1), [
    'run_outputs',
    {
      first: 1000,
      after: undefined,
      where: {
        AND: [
          { data: { path: 'run_id', equals: 'run1' } },
          { data: { path: 'node_id', equals: 'dev' } },
        ],
      },
      orderBy: [{ field: 'ordinal', direction: 'asc' }],
    },
  ]);
});

test('allRunOutputs: scopes by node and run', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: '', payload: {} });
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {} });
  await appendRunOutput(a.da, { runId: 'run2', nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: '', payload: {} });
  assert.equal((await allRunOutputs(a.da, 'run1', 'analyst')).length, 1);
});

test('outputsForRun: returns every node output produced_at-ascending (retro view)', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {}, producedAt: '2026-06-17T10:02:00.000Z' });
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'analyst', ordinal: 1, name: 'plan', schemaRef: '', payload: {}, producedAt: '2026-06-17T10:01:00.000Z' });
  const out = await outputsForRun(a.da, 'run1');
  assert.deepEqual(out.map((o) => o.nodeId), ['analyst', 'dev']);
});

test('outputsForRun: pushes run filter and producedAt ordering into storage', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal: 1, name: 'change', schemaRef: '', payload: {} });

  await outputsForRun(a.da, 'run1');

  assert.deepEqual(a.listRowsArgs.at(-1), [
    'run_outputs',
    {
      first: 1000,
      after: undefined,
      where: { data: { path: 'run_id', equals: 'run1' } },
      orderBy: [{ field: 'producedAt', direction: 'asc' }],
    },
  ]);
});

test('appendRunOutput: an over-cap payload is stored as a marker + payload_ref', async () => {
  const a = makeFakeDa();
  await appendRunOutput(a.da, {
    runId: 'run1',
    nodeId: 'analyst',
    ordinal: 1,
    name: 'plan',
    schemaRef: 'schema:plan',
    payload: { big: 'x'.repeat(20_000) },
    attemptId: 'attempt_abc',
  });
  assert.deepEqual(a.rows[0].data.payload, { _truncated: true });
  assert.equal(a.rows[0].data.payload_ref, 'attempt:attempt_abc');
});
