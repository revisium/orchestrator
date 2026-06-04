import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { cancelRun } from './cancel-run.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { assertReadyError?: Error } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  const da: ControlPlaneDataAccess = {
    async assertReady() {
      if (opts.assertReadyError) throw opts.assertReadyError;
    },
    async listRows() {
      return [];
    },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      return runRows.find((r) => r.rowId === rowId) ?? null;
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
      creates.push({ table, rowId, data });
      return { rowId, data };
    },
    async updateRow(table, rowId, data) {
      calls.push(`update:${table}:${rowId}`);
      return { rowId, data };
    },
    async patchRow(table, rowId, ops) {
      calls.push(`patch:${table}:${rowId}`);
      patches.push({ table, rowId, ops });
      return { rowId, data: { id: rowId } };
    },
  };
  return { da, calls, patches, creates };
}

const RUN = (status: string): ControlPlaneRow => ({
  rowId: 'run-a',
  data: { id: 'run-a', title: 'Run A', status, priority: 0, repos: ['r'] },
});

test('unknown runId returns null and writes zero rows', async () => {
  const { da, calls } = makeFake([]);
  const result = await cancelRun(da, 'nope');
  assert.equal(result, null);
  assert.ok(calls.includes('getRow:task_runs:nope'), 'getRow should be called');
  assert.ok(!calls.some((c) => c.startsWith('patch:')), 'no patch should be called');
  assert.ok(!calls.some((c) => c.startsWith('update:')), 'no update should be called');
  assert.ok(!calls.some((c) => c.startsWith('create:')), 'no create should be called');
});

test('known run patches status to cancelled', async () => {
  const { da, patches } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  const result = await cancelRun(da, 'run-a', { now });
  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'running', status: 'cancelled' });
  assert.equal(patches.length, 1);
  assert.equal(patches[0].table, 'task_runs');
  assert.equal(patches[0].rowId, 'run-a');
  assert.ok(patches[0].ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'cancelled'));
  assert.ok(patches[0].ops.some((op) => op.op === 'replace' && op.path === 'updated_at' && op.value === '2026-06-04T00:00:00.000Z'));
});

test('read precedes write', async () => {
  const { da, calls } = makeFake([RUN('running')]);
  await cancelRun(da, 'run-a');
  const getIdx = calls.indexOf('getRow:task_runs:run-a');
  const patchIdx = calls.indexOf('patch:task_runs:run-a');
  assert.ok(getIdx >= 0, 'getRow must appear in calls');
  assert.ok(patchIdx >= 0, 'patch must appear in calls');
  assert.ok(getIdx < patchIdx, 'getRow must appear before patch');
});

test('assertReady is honored and blocks getRow and patch', async () => {
  const { da, calls } = makeFake([], { assertReadyError: new Error('down') });
  await assert.rejects(() => cancelRun(da, 'run-a'), /down/);
  assert.ok(!calls.some((c) => c.startsWith('getRow:')), 'no getRow should run');
  assert.ok(!calls.some((c) => c.startsWith('patch:')), 'no patch should run');
});

test('already-cancelled run still patches and reports previousStatus cancelled', async () => {
  const { da, patches } = makeFake([RUN('cancelled')]);
  const result = await cancelRun(da, 'run-a', { now: new Date('2026-06-04T00:00:00.000Z') });
  assert.ok(result !== null);
  assert.equal(result.previousStatus, 'cancelled');
  assert.equal(result.status, 'cancelled');
  assert.equal(patches.length, 1);
});

test('known run emits a run_cancelled event', async () => {
  const { da, creates } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  await cancelRun(da, 'run-a', { now, idSuffix: 'abc123ef' });

  const events = creates.filter((c) => c.table === 'events');
  assert.equal(events.length, 1, 'exactly one event row written');
  const event = events[0];
  assert.equal(event.rowId, 'event_20260604T000000000Z_run-cancelled_abc123ef');
  assert.equal(event.data.id, event.rowId);
  assert.equal(event.data.type, 'run_cancelled');
  assert.equal(event.data.run_id, 'run-a');
  assert.equal(event.data.actor, 'cli');
  assert.equal(event.data.created_at, '2026-06-04T00:00:00.000Z');
  assert.deepEqual(event.data.payload, { source: 'revo run cancel', previous_status: 'running' });
});
