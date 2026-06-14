/**
 * fail-run.test.ts — 0008 #2: terminal-failure surfacing + run-status integrity.
 *
 * Mirrors cancel-run.test.ts's stateful in-memory data-access fake and asserts:
 *   - event-first ordering (run_failed event created BEFORE the status patch);
 *   - status patched to 'failed' with the true previous_status;
 *   - deterministic event id (no timestamp) + ROW_CONFLICT idempotency on replay;
 *   - already-failed skips duplicate event + run-row refresh;
 *   - the persisted reason is token-redacted (secrets never reach Revisium).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { failRun } from './fail-run.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

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
      let source: ControlPlaneRow[] = [];
      if (table === 'tasks') source = opts.taskRows ?? [];
      if (table === 'steps') source = opts.stepRows ?? [];
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

test('failRun: returns null when the run does not exist', async () => {
  const { da } = makeFake([]);
  const result = await failRun(da, 'missing', 'boom');
  assert.equal(result, null);
});

test('failRun: writes run_failed event FIRST, then patches status → failed', async () => {
  const { da, calls, creates, patches } = makeFake([RUN('ready')]);
  const result = await failRun(da, 'run-a', 'step exploded', { now: new Date('2026-06-11T00:00:00Z') });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'ready', status: 'failed' });

  // Event-first ordering: the events.create precedes the task_runs.patch.
  const createIdx = calls.findIndex((c) => c.startsWith('create:events:'));
  const patchIdx = calls.findIndex((c) => c.startsWith('patch:task_runs:'));
  assert.ok(createIdx >= 0 && patchIdx >= 0, 'both create + patch must happen');
  assert.ok(createIdx < patchIdx, 'event must be written BEFORE the status patch');

  // Deterministic event id (mirrors append-event / cancel-run).
  const expectedId = `event_${fnv1a64Hex('run-a|run_failed')}`;
  assert.equal(creates[0]?.rowId, expectedId);
  assert.equal(creates[0]?.data.type, 'run_failed');
  const payload = creates[0]?.data.payload as Record<string, unknown>;
  assert.equal(payload.reason, 'step exploded');
  assert.equal(payload.previous_status, 'ready');

  // Status patched to failed.
  const statusOp = patches[0]?.ops.find((o) => o.op === 'replace' && o.path === 'status');
  assert.equal(statusOp?.value, 'failed');
});

test('failRun: already-failed skips event and run patch when related rows are current', async () => {
  const { da, creates, patches } = makeFake([RUN('failed')]);
  const result = await failRun(da, 'run-a', 'again');
  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'failed', status: 'failed' });
  assert.equal(creates.length, 0, 'no event written when already failed');
  assert.equal(
    patches.filter((patch) => patch.table === 'task_runs').length,
    0,
    'no run patch written when already failed',
  );
  assert.equal(patches.length, 0, 'no related patches when related rows are current');
});

test('failRun: already-failed replay reconciles stale related task and step rows to failed', async () => {
  const taskRows: ControlPlaneRow[] = [
    { rowId: 'task-stale', data: { id: 'task-stale', run_id: 'run-a', status: 'running' } },
    { rowId: 'task-current', data: { id: 'task-current', run_id: 'run-a', status: 'failed' } },
    { rowId: 'task-other-run', data: { id: 'task-other-run', run_id: 'run-b', status: 'running' } },
  ];
  const stepRows: ControlPlaneRow[] = [
    { rowId: 'step-stale', data: { id: 'step-stale', run_id: 'run-a', status: 'running' } },
    { rowId: 'step-current', data: { id: 'step-current', run_id: 'run-a', status: 'failed' } },
  ];
  const { da, creates, patches } = makeFake(
    [RUN('failed')],
    { taskRows, stepRows },
  );

  const result = await failRun(da, 'run-a', 'again', { now: new Date('2026-06-11T00:00:00Z') });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'failed', status: 'failed' });
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
    assert.ok(patch.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'failed'));
    assert.ok(patch.ops.some((op) => op.op === 'replace' && op.path === 'updated_at' && op.value === '2026-06-11T00:00:00.000Z'));
  }
});

test('failRun: ROW_CONFLICT on replay still applies the status patch (idempotent)', async () => {
  const { da, patches } = makeFake([RUN('ready')], { throwConflictOnEvent: true });
  // First call writes the event + patch.
  await failRun(da, 'run-a', 'boom');
  // Reset run-row back to a non-failed state to simulate a replay BEFORE the first patch landed.
  // (The fake patched status to 'failed'; force it back to exercise the conflict branch.)
  const row = await da.getRow('task_runs', 'run-a');
  if (row) row.data.status = 'ready';
  const result = await failRun(da, 'run-a', 'boom');
  assert.equal(result?.status, 'failed');
  // The conflict path still issued a status patch.
  assert.ok(patches.some((p) => p.table === 'task_runs'), 'status patch must be applied on the conflict path');
});

test('failRun: token-shaped reason is redacted before persisting (no secrets in Revisium)', async () => {
  const { da, creates } = makeFake([RUN('running')]);
  await failRun(da, 'run-a', 'gh failed: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 invalid');
  const payload = creates[0]?.data.payload as Record<string, unknown>;
  assert.ok(!String(payload.reason).includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), 'token must be redacted');
  assert.match(String(payload.reason), /\[REDACTED\]/);
});
