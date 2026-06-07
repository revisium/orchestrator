/**
 * B2 id-bound unit tests for appendRunEvent / appendRunCost.
 *
 * Verifies:
 *  1. eventId / costId are ≤ 64 chars even with a max-length runId (worst-case).
 *  2. Ids are deterministic: two calls with the same inputs produce the same id.
 *  3. ROW_CONFLICT on second call is silently skipped (idempotent replay).
 *  4. A different type / index produces a different id.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRunEvent, appendRunCost } from './append-event.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

// Max-length runId (saturated stem — worst case from buildIds: 64 chars)
const MAX_RUN_ID = 'r'.repeat(64);

type FakeRow = { rowId: string; data: Record<string, unknown> };

function makeFakeDa(opts: { throwConflict?: boolean } = {}): {
  da: ControlPlaneDataAccess;
  rows: FakeRow[];
} {
  const rows: FakeRow[] = [];
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async () => null,
    createRow: async (table, rowId, data) => {
      if (opts.throwConflict) {
        throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      }
      const row = { rowId, data };
      rows.push(row);
      return { rowId, data };
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _patches) => ({ rowId, data: {} }),
  };
  return { da, rows };
}

// ─── appendRunEvent ──────────────────────────────────────────────────────────

test('appendRunEvent: eventId length ≤ 64 with max-length runId', async () => {
  const { da, rows } = makeFakeDa();
  await appendRunEvent(da, {
    runId: MAX_RUN_ID,
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'architect',
    type: 'step_succeeded',
    payload: {},
  });
  assert.equal(rows.length, 1);
  const eventId = rows[0]?.rowId ?? '';
  assert.ok(eventId.length <= 64, `eventId too long: ${eventId.length} chars (id=${eventId})`);
});

test('appendRunEvent: eventId is deterministic across two calls (same inputs)', async () => {
  const { da: da1, rows: rows1 } = makeFakeDa();
  const { da: da2, rows: rows2 } = makeFakeDa();
  const input = {
    runId: MAX_RUN_ID,
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'developer',
    type: 'step_succeeded',
    payload: {},
  };
  await appendRunEvent(da1, input);
  await appendRunEvent(da2, input);
  assert.equal(rows1[0]?.rowId, rows2[0]?.rowId);
});

test('appendRunEvent: second call with ROW_CONFLICT is a no-op (idempotent replay)', async () => {
  const { da } = makeFakeDa({ throwConflict: true });
  // Should NOT throw — silently skips on conflict
  await appendRunEvent(da, {
    runId: 'run-1',
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'architect',
    type: 'step_succeeded',
    payload: {},
  });
  // Reaches here = no throw = pass
});

test('appendRunEvent: different type produces different eventId', async () => {
  const { da: da1, rows: rows1 } = makeFakeDa();
  const { da: da2, rows: rows2 } = makeFakeDa();
  const base = {
    runId: 'run-1',
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'architect',
    payload: {},
  };
  await appendRunEvent(da1, { ...base, type: 'step_succeeded' });
  await appendRunEvent(da2, { ...base, type: 'pipeline_blocked' });
  assert.notEqual(rows1[0]?.rowId, rows2[0]?.rowId);
});

test('appendRunEvent: non-ROW_CONFLICT errors are rethrown', async () => {
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async () => null,
    createRow: async () => {
      throw new ControlPlaneError('HTTP_ERROR', 'network error');
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _patches) => ({ rowId, data: {} }),
  };
  await assert.rejects(
    () =>
      appendRunEvent(da, {
        runId: 'run-1',
        taskId: 'task-1',
        stepId: 'step-1',
        stepKey: 'architect',
        type: 'step_succeeded',
        payload: {},
      }),
    (err: unknown) => {
      assert.ok(err instanceof ControlPlaneError);
      assert.equal(err.code, 'HTTP_ERROR');
      return true;
    },
  );
});

// ─── appendRunCost ───────────────────────────────────────────────────────────

test('appendRunCost: costId length ≤ 64 with max-length runId', async () => {
  const { da, rows } = makeFakeDa();
  await appendRunCost(da, {
    runId: MAX_RUN_ID,
    stepId: 'step-1',
    stepKey: 'architect',
    attemptId: 'attempt-1',
    cost: { modelProfile: 'deep', inputTokens: 100, outputTokens: 50, costAmount: 0.01 },
    index: 0,
  });
  assert.equal(rows.length, 1);
  const costId = rows[0]?.rowId ?? '';
  assert.ok(costId.length <= 64, `costId too long: ${costId.length} chars (id=${costId})`);
});

test('appendRunCost: costId is deterministic (same inputs → same id)', async () => {
  const { da: da1, rows: rows1 } = makeFakeDa();
  const { da: da2, rows: rows2 } = makeFakeDa();
  const input = {
    runId: 'run-abc',
    stepId: 'step-1',
    stepKey: 'reviewer#1',
    attemptId: 'attempt-1',
    cost: { modelProfile: 'standard', inputTokens: 0, outputTokens: 0, costAmount: 0 },
    index: 0,
  };
  await appendRunCost(da1, input);
  await appendRunCost(da2, input);
  assert.equal(rows1[0]?.rowId, rows2[0]?.rowId);
});

test('appendRunCost: ROW_CONFLICT on second call is a no-op', async () => {
  const { da } = makeFakeDa({ throwConflict: true });
  await appendRunCost(da, {
    runId: 'run-1',
    stepId: 'step-1',
    stepKey: 'developer',
    attemptId: 'attempt-1',
    cost: { modelProfile: 'standard', inputTokens: 0, outputTokens: 0, costAmount: 0 },
    index: 0,
  });
  // No throw = pass
});

test('appendRunCost: different index produces different costId', async () => {
  const { da: da1, rows: rows1 } = makeFakeDa();
  const { da: da2, rows: rows2 } = makeFakeDa();
  const base = {
    runId: 'run-1',
    stepId: 'step-1',
    stepKey: 'developer',
    attemptId: 'attempt-1',
    cost: { modelProfile: 'standard', inputTokens: 0, outputTokens: 0, costAmount: 0 },
  };
  await appendRunCost(da1, { ...base, index: 0 });
  await appendRunCost(da2, { ...base, index: 1 });
  assert.notEqual(rows1[0]?.rowId, rows2[0]?.rowId);
});
