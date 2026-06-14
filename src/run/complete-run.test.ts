import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';
import { completeRun } from './complete-run.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: { throwConflictOnEvent?: boolean; taskRows?: ControlPlaneRow[]; stepRows?: ControlPlaneRow[] } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  const createdEventIds = new Set<string>();
  const store = new Map<string, Record<string, unknown>>(
    [
      ...runRows.map((r) => [`task_runs:${r.rowId}`, { ...r.data }] as const),
      ...(opts.taskRows ?? []).map((r) => [`tasks:${r.rowId}`, { ...r.data }] as const),
      ...(opts.stepRows ?? []).map((r) => [`steps:${r.rowId}`, { ...r.data }] as const),
    ],
  );

  const da: ControlPlaneDataAccess = {
    async assertReady() {},
    async listRows(table, options) {
      const source =
        table === 'tasks' ? (opts.taskRows ?? []) :
          table === 'steps' ? (opts.stepRows ?? []) :
            [];
      const start = options?.after
        ? source.findIndex((row) => row.cursor === options.after) + 1
        : 0;
      return source.slice(start, start + (options?.first ?? source.length));
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

test('completeRun: already-completed skips event and run patch when related rows are current', async () => {
  const { da, creates, patches } = makeFake([RUN('completed')]);
  const result = await completeRun(da, 'run-a');
  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'completed', status: 'completed' });
  assert.equal(creates.length, 0, 'no event written when already completed');
  assert.equal(patches.length, 0, 'no patch written when already completed');
});

test('completeRun: already-completed replay reconciles stale related task and step rows', async () => {
  const taskRows: ControlPlaneRow[] = [
    { rowId: 'task-stale', data: { id: 'task-stale', run_id: 'run-a', status: 'running' } },
    { rowId: 'task-current', data: { id: 'task-current', run_id: 'run-a', status: 'completed' } },
    { rowId: 'task-other-run', data: { id: 'task-other-run', run_id: 'run-b', status: 'running' } },
  ];
  const stepRows: ControlPlaneRow[] = [
    { rowId: 'step-stale', data: { id: 'step-stale', run_id: 'run-a', status: 'completed' } },
    { rowId: 'step-current', data: { id: 'step-current', run_id: 'run-a', status: 'succeeded' } },
  ];
  const { da, creates, patches } = makeFake(
    [RUN('completed')],
    { taskRows, stepRows },
  );

  const result = await completeRun(da, 'run-a', { now: new Date('2026-06-13T00:00:00Z') });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'completed', status: 'completed' });
  assert.equal(creates.length, 0, 'already-terminal replay must not write another event');
  assert.equal(
    patches.filter((patch) => patch.table === 'task_runs').length,
    0,
    'already-terminal replay must not refresh the run row',
  );
  assert.deepEqual(
    patches.map((patch) => `${patch.table}:${patch.rowId}`).sort(),
    ['steps:step-stale', 'tasks:task-stale'],
  );
  for (const patch of patches) {
    const expectedStatus = patch.table === 'steps' ? 'succeeded' : 'completed';
    assert.ok(patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === expectedStatus));
    assert.ok(patch.ops.some((op) => op.op === 'replace' && op.path === 'updated_at' && op.value === '2026-06-13T00:00:00.000Z'));
  }
});

test('completeRun: terminal propagation preserves real terminal step outcomes', async () => {
  const stepRows: ControlPlaneRow[] = [
    { rowId: 'step-running', data: { id: 'step-running', run_id: 'run-a', status: 'running' } },
    { rowId: 'step-ready', data: { id: 'step-ready', run_id: 'run-a', status: 'ready' } },
    { rowId: 'step-failed', data: { id: 'step-failed', run_id: 'run-a', status: 'failed' } },
    { rowId: 'step-skipped', data: { id: 'step-skipped', run_id: 'run-a', status: 'skipped' } },
    { rowId: 'step-dead', data: { id: 'step-dead', run_id: 'run-a', status: 'dead' } },
    { rowId: 'step-succeeded', data: { id: 'step-succeeded', run_id: 'run-a', status: 'succeeded' } },
  ];
  const { da, patches } = makeFake([RUN('ready')], { stepRows });

  await completeRun(da, 'run-a', { now: new Date('2026-06-13T00:00:00Z') });

  assert.deepEqual(
    patches.filter((patch) => patch.table === 'steps').map((patch) => patch.rowId).sort(),
    ['step-ready', 'step-running'],
  );
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

test('completeRun: paginates related task and step status propagation beyond 500 rows', async () => {
  const relatedRows = (prefix: string): ControlPlaneRow[] => Array.from({ length: 501 }, (_, index) => ({
    rowId: `${prefix}-${index}`,
    cursor: `${prefix}-cursor-${index}`,
    data: { id: `${prefix}-${index}`, run_id: 'run-a', status: 'running' },
  }));
  const tasks = relatedRows('task');
  const steps = relatedRows('step');
  const listCalls: Array<{ table: RuntimeTable; first?: number; after?: string }> = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  let activePatches = 0;
  let maxActivePatches = 0;

  const da: ControlPlaneDataAccess = {
    async assertReady() {},
    async listRows(table, options) {
      listCalls.push({ table, first: options?.first, after: options?.after });
      const source = table === 'tasks' ? tasks : table === 'steps' ? steps : [];
      const start = options?.after
        ? source.findIndex((row) => row.cursor === options.after) + 1
        : 0;
      return source.slice(start, start + (options?.first ?? 100));
    },
    async getRow(table, rowId) {
      if (table === 'task_runs' && rowId === 'run-a') return RUN('running');
      return null;
    },
    async createRow(_table, rowId, data) {
      return { rowId, data };
    },
    async updateRow(_table, rowId, data) {
      return { rowId, data };
    },
    async patchRow(table, rowId, ops) {
      activePatches++;
      maxActivePatches = Math.max(maxActivePatches, activePatches);
      await new Promise<void>((resolve) => setImmediate(resolve));
      patches.push({ table, rowId, ops });
      activePatches--;
      return { rowId, data: { id: rowId } };
    },
  };

  const result = await completeRun(da, 'run-a', { now: new Date('2026-06-13T00:00:00Z') });

  assert.equal(result?.status, 'completed');
  assert.deepEqual(
    listCalls.map((call) => ({ table: call.table, first: call.first, after: call.after })),
    [
      { table: 'tasks', first: 500, after: undefined },
      { table: 'steps', first: 500, after: undefined },
      { table: 'tasks', first: 500, after: 'task-cursor-499' },
      { table: 'steps', first: 500, after: 'step-cursor-499' },
    ],
  );
  assert.equal(patches.filter((patch) => patch.table === 'tasks').length, 501);
  assert.equal(patches.filter((patch) => patch.table === 'steps').length, 501);
  assert.equal(maxActivePatches, 20, 'related-row terminal patches must be concurrency bounded');
  assert.ok(
    patches
      .filter((patch) => patch.table === 'tasks')
      .every((patch) => patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'completed')),
    'task propagation keeps the run terminal status',
  );
  assert.ok(
    patches
      .filter((patch) => patch.table === 'steps')
      .every((patch) => patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'succeeded')),
    'completed run propagates to valid step status succeeded',
  );
});
