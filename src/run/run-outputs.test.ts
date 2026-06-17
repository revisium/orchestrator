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
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

type FakeRow = { rowId: string; data: Record<string, unknown> };

function makeFakeDa(opts: { throwConflict?: boolean } = {}): { da: ControlPlaneDataAccess; rows: FakeRow[] } {
  const rows: FakeRow[] = [];
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async (_table, options) => {
      const where = options?.where as { data?: { path?: string; equals?: unknown } } | undefined;
      const path = where?.data?.path;
      const equals = where?.data?.equals;
      return rows
        .filter((r) => !path || r.data[path] === equals)
        .map((r) => ({ rowId: r.rowId, data: r.data }));
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
  return { da, rows };
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

test('allRunOutputs: returns rows ordinal-ascending (loop history)', async () => {
  const a = makeFakeDa();
  for (const ordinal of [2, 1, 3]) {
    await appendRunOutput(a.da, { runId: 'run1', nodeId: 'dev', ordinal, name: 'change', schemaRef: '', payload: {} });
  }
  const all = await allRunOutputs(a.da, 'run1', 'dev');
  assert.deepEqual(all.map((o) => o.ordinal), [1, 2, 3]);
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
