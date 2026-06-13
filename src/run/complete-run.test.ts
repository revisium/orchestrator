import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { completeRun } from './complete-run.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { throwConflictOnEvent?: boolean } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  const createdEventIds = new Set<string>();
  const store = new Map<string, Record<string, unknown>>(
    runRows.map((r) => [`task_runs:${r.rowId}`, { ...r.data }]),
  );

  const da: ControlPlaneDataAccess = {
    async assertReady() {},
    async listRows() {
      return [];
    },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      const key = `${String(table)}:${rowId}`;
      const data = store.get(key) ?? runRows.find((r) => r.rowId === rowId)?.data ?? null;
      return data ? { rowId, data } : null;
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      if (table === 'events' && opts.throwConflictOnEvent && createdEventIds.has(rowId)) {
        throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      }
      if (table === 'events') createdEventIds.add(rowId);
      creates.push({ table, rowId, data });
      return { rowId, data };
    },
    async updateRow(table, rowId, data) {
      return { rowId, data };
    },
    async patchRow(table, rowId, ops) {
      calls.push(`patch:${table}:${rowId}`);
      patches.push({ table, rowId, ops });
      const key = `${String(table)}:${rowId}`;
      const existing = store.get(key) ?? runRows.find((r) => r.rowId === rowId)?.data;
      if (existing) {
        const updated = { ...existing };
        for (const op of ops) if (op.op === 'replace') updated[op.path] = op.value;
        store.set(key, updated);
      }
      return { rowId, data: { id: rowId } };
    },
  };
  return { da, calls, patches, creates };
}

const RUN = (status: string): ControlPlaneRow => ({
  rowId: 'run-a',
  data: { id: 'run-a', title: 'Run A', status, priority: 0, repos: ['r'] },
});

test('completeRun: returns null when the run does not exist', async () => {
  const { da } = makeFake([]);
  const result = await completeRun(da, 'missing');
  assert.equal(result, null);
});

test('completeRun: writes run_completed event FIRST, then patches status to completed', async () => {
  const { da, calls, creates, patches } = makeFake([RUN('ready')]);
  const result = await completeRun(da, 'run-a', {
    now: new Date('2026-06-13T00:00:00Z'),
    verdict: 'PASS',
    iterations: 1,
  });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'ready', status: 'completed' });
  const createIdx = calls.findIndex((c) => c.startsWith('create:events:'));
  const patchIdx = calls.findIndex((c) => c.startsWith('patch:task_runs:'));
  assert.ok(createIdx >= 0 && patchIdx >= 0, 'both create + patch must happen');
  assert.ok(createIdx < patchIdx, 'event must be written before the status patch');

  const expectedId = `event_${fnv1a64Hex('run-a|run_completed')}`;
  assert.equal(creates[0]?.rowId, expectedId);
  assert.equal(creates[0]?.data.type, 'run_completed');
  assert.equal(creates[0]?.data.actor, 'pipeline');
  assert.deepEqual(creates[0]?.data.payload, {
    source: 'workflow-complete',
    verdict: 'PASS',
    iterations: 1,
    previous_status: 'ready',
  });
  assert.ok(patches[0]?.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'completed'));
});

test('completeRun: already-completed is a no-op', async () => {
  const { da, creates, patches } = makeFake([RUN('completed')]);
  const result = await completeRun(da, 'run-a');
  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'completed', status: 'completed' });
  assert.equal(creates.length, 0, 'no event written when already completed');
  assert.equal(patches.length, 0, 'no patch written when already completed');
});

test('completeRun: ROW_CONFLICT on replay still applies the status patch', async () => {
  const { da, patches } = makeFake([RUN('ready')], { throwConflictOnEvent: true });
  await completeRun(da, 'run-a');
  const row = await da.getRow('task_runs', 'run-a');
  if (row) row.data.status = 'ready';
  const result = await completeRun(da, 'run-a');
  assert.equal(result?.status, 'completed');
  assert.ok(patches.some((p) => p.table === 'task_runs'), 'status patch must be applied on conflict');
});
