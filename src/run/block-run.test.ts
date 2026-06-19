import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { blockRun } from './block-run.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { taskRows?: ControlPlaneRow[] } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  const store = new Map<string, Record<string, unknown>>(
    [
      ...runRows.map((row) => [`task_runs:${row.rowId}`, { ...row.data }] as const),
      ...(opts.taskRows ?? []).map((row) => [`tasks:${row.rowId}`, { ...row.data }] as const),
    ],
  );

  const da: ControlPlaneDataAccess = {
    async assertReady() {},
    async listRows(table, options) {
      const source = table === 'tasks' ? (opts.taskRows ?? []) : [];
      const start = options?.after
        ? source.findIndex((row) => row.cursor === options.after) + 1
        : 0;
      return source.slice(start, start + (options?.first ?? source.length));
    },
    async getRow(table, rowId) {
      calls.push(`getRow:${table}:${rowId}`);
      const key = `${String(table)}:${rowId}`;
      const data = store.get(key) ?? runRows.find((row) => row.rowId === rowId)?.data ?? null;
      return data ? { rowId, data } : null;
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}:${rowId}`);
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
      const existing = store.get(key) ?? runRows.find((row) => row.rowId === rowId)?.data;
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

test('blockRun writes run_blocked event first and moves rows out of ready', async () => {
  const taskRows: ControlPlaneRow[] = [
    { rowId: 'task-a', data: { id: 'task-a', run_id: 'run-a', status: 'ready' } },
  ];
  const { da, calls, creates, patches } = makeFake([RUN('ready')], { taskRows });

  const result = await blockRun(da, 'run-a', {
    now: new Date('2026-06-14T00:00:00Z'),
    reason: 'integrate',
  });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'ready', status: 'paused' });
  const createIdx = calls.findIndex((call) => call.startsWith('create:events:'));
  const patchIdx = calls.findIndex((call) => call.startsWith('patch:task_runs:'));
  assert.ok(createIdx >= 0 && patchIdx >= 0, 'both event create and run patch must happen');
  assert.ok(createIdx < patchIdx, 'event must be written before the status patch');

  assert.equal(creates[0]?.rowId, `event_${fnv1a64Hex('run-a|run_blocked')}`);
  assert.equal(creates[0]?.data.type, 'run_blocked');
  assert.deepEqual(creates[0]?.data.payload, {
    source: 'pipeline-blocked',
    reason: 'integrate',
    previous_status: 'ready',
  });
  assert.ok(patches.some((patch) =>
    patch.table === 'task_runs' &&
    patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'paused'),
  ));
  assert.ok(patches.some((patch) =>
    patch.table === 'tasks' &&
    patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'paused'),
  ));
});
