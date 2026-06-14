import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { cancelRun } from './cancel-run.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { fnv1a64Hex } from '../control-plane/steps.js';

function makeFake(
  runRows: ControlPlaneRow[],
  opts: {
    assertReadyError?: Error;
    throwConflictOnEvent?: boolean;
    taskRows?: ControlPlaneRow[];
    stepRows?: ControlPlaneRow[];
  } = {},
) {
  const calls: string[] = [];
  const patches: Array<{ table: RuntimeTable; rowId: string; ops: PatchOperation[] }> = [];
  const creates: Array<{ table: RuntimeTable; rowId: string; data: Record<string, unknown> }> = [];
  // Track which event ids were created (for ROW_CONFLICT dedup testing)
  const createdEventIds = new Set<string>();
  // In-memory store for stateful getRow (applies patches so subsequent reads see the update).
  const store = new Map<string, Record<string, unknown>>(
    [
      ...runRows.map((r) => [`${String('task_runs')}:${r.rowId}`, { ...r.data }] as const),
      ...(opts.taskRows ?? []).map((r) => [`tasks:${r.rowId}`, { ...r.data }] as const),
      ...(opts.stepRows ?? []).map((r) => [`steps:${r.rowId}`, { ...r.data }] as const),
    ],
  );

  const da: ControlPlaneDataAccess = {
    async assertReady() {
      if (opts.assertReadyError) throw opts.assertReadyError;
    },
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
      if (table === 'events' && opts.throwConflictOnEvent) {
        if (createdEventIds.has(rowId)) {
          throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
        }
        createdEventIds.add(rowId);
      }
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
      // Apply patches to in-memory store so subsequent getRow calls see the updated state.
      const key = `${String(table)}:${rowId}`;
      const existing = store.get(key) ?? runRows.find((r) => r.rowId === rowId)?.data;
      if (existing) {
        const updated = { ...existing };
        for (const op of ops) {
          if (op.op === 'replace') {
            updated[op.path] = op.value;
          }
        }
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

// C1 (0004 review): already-cancelled run must NOT re-patch task_runs (read-then-guard).
// The RUN mutation is skipped when status is already 'cancelled', making the call
// replay-idempotent on the run row (no fresh updated_at on replay). Related rows may still
// be reconciled by the shared terminal-status helper.
test('C1: already-cancelled run skips task_runs patch but still returns result', async () => {
  const { da, patches } = makeFake([RUN('cancelled')]);
  const result = await cancelRun(da, 'run-a', { now: new Date('2026-06-04T00:00:00.000Z') });
  assert.ok(result !== null);
  assert.equal(result.previousStatus, 'cancelled');
  assert.equal(result.status, 'cancelled');
  // C1: NO patch to task_runs when already cancelled.
  const runPatches = patches.filter((p) => p.table === 'task_runs');
  assert.equal(runPatches.length, 0, 'task_runs must NOT be patched when already cancelled (C1)');
});

test('C1: already-cancelled replay reconciles stale steps to skipped', async () => {
  const taskRows: ControlPlaneRow[] = [
    { rowId: 'task-stale', data: { id: 'task-stale', run_id: 'run-a', status: 'running' } },
    { rowId: 'task-current', data: { id: 'task-current', run_id: 'run-a', status: 'cancelled' } },
    { rowId: 'task-other-run', data: { id: 'task-other-run', run_id: 'run-b', status: 'running' } },
  ];
  const stepRows: ControlPlaneRow[] = [
    { rowId: 'step-stale', data: { id: 'step-stale', run_id: 'run-a', status: 'cancelled' } },
    { rowId: 'step-current', data: { id: 'step-current', run_id: 'run-a', status: 'skipped' } },
  ];
  const { da, creates, patches } = makeFake(
    [RUN('cancelled')],
    { taskRows, stepRows },
  );

  const result = await cancelRun(da, 'run-a', { now: new Date('2026-06-04T00:00:00.000Z') });

  assert.deepEqual(result, { runId: 'run-a', previousStatus: 'cancelled', status: 'cancelled' });
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
  const taskPatch = patches.find((patch) => patch.table === 'tasks');
  const stepPatch = patches.find((patch) => patch.table === 'steps');
  assert.ok(taskPatch?.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'cancelled'));
  assert.ok(stepPatch?.ops.some((op) => op.op === 'replace' && op.path === 'status' && op.value === 'skipped'));
});

// A10a (G3-note): UPDATED in place — old timestamp-id assertion replaced with deterministic id.
// The new id is `event_${fnv1a64Hex(`${runId}|run_cancelled`)}` (no timestamp, replay-safe).
// `idSuffix` is still accepted for back-compat but no longer influences the id.
test('known run emits a run_cancelled event with deterministic id (G3)', async () => {
  const { da, creates } = makeFake([RUN('running')]);
  const now = new Date('2026-06-04T00:00:00.000Z');
  await cancelRun(da, 'run-a', { now, idSuffix: 'abc123ef' });

  const events = creates.filter((c) => c.table === 'events');
  assert.equal(events.length, 1, 'exactly one event row written');
  const event = events[0];
  assert.ok(event);
  // A10a: deterministic id — no timestamp, no idSuffix in the id.
  const expectedId = `event_${fnv1a64Hex('run-a|run_cancelled')}`;
  assert.equal(event.rowId, expectedId, `event id must be deterministic: expected ${expectedId}`);
  assert.equal(event.data.id, event.rowId);
  assert.equal(event.data.type, 'run_cancelled');
  assert.equal(event.data.run_id, 'run-a');
  assert.equal(event.data.actor, 'cli');
  assert.equal(event.data.created_at, '2026-06-04T00:00:00.000Z');
  assert.deepEqual(event.data.payload, { source: 'revo run cancel', previous_status: 'running' });
});

// CR-B: caller-aware actor/source — pipeline gate reject uses actor:'pipeline',source:'plan-gate-reject'.
// CLI `run cancel` keeps the default actor:'cli',source:'revo run cancel' (unchanged).
test('CR-B: gate cancel uses pipeline actor/source; CLI cancel uses cli defaults', async () => {
  // CLI path (no opts): defaults apply.
  const { da: cliDa, creates: cliCreates } = makeFake([RUN('running')]);
  await cancelRun(cliDa, 'run-a', { now: new Date('2026-06-08T00:00:00.000Z') });
  const cliEvent = cliCreates.find((c) => c.table === 'events');
  assert.ok(cliEvent, 'CLI cancel must write an event');
  assert.equal(cliEvent.data.actor, 'cli', 'CLI cancel: actor must be cli');
  assert.equal((cliEvent.data.payload as Record<string, unknown>).source, 'revo run cancel', 'CLI cancel: source must be revo run cancel');

  // Gate path: pipeline metadata.
  const { da: gateDa, creates: gateCreates } = makeFake([RUN('running')]);
  await cancelRun(gateDa, 'run-a', { now: new Date('2026-06-08T00:00:00.000Z'), actor: 'pipeline', source: 'plan-gate-reject' });
  const gateEvent = gateCreates.find((c) => c.table === 'events');
  assert.ok(gateEvent, 'gate cancel must write an event');
  assert.equal(gateEvent.data.actor, 'pipeline', 'gate cancel: actor must be pipeline');
  assert.equal((gateEvent.data.payload as Record<string, unknown>).source, 'plan-gate-reject', 'gate cancel: source must be plan-gate-reject');
});

// A10b (G3): double-cancel ROW_CONFLICT no-op — second call does not throw; exactly one event row.
test('double-cancel: second cancelRun swallows ROW_CONFLICT and returns result (G3 idempotent)', async () => {
  // First call: creates the event row.
  const { da: da1, creates: creates1 } = makeFake([RUN('running')], { throwConflictOnEvent: true });
  const result1 = await cancelRun(da1, 'run-a');
  assert.ok(result1 !== null, 'first cancel must succeed');
  assert.equal(result1.status, 'cancelled');
  const events1 = creates1.filter((c) => c.table === 'events');
  assert.equal(events1.length, 1, 'first cancel: exactly one event row');

  // Second call on the same da (throwConflictOnEvent=true simulates ROW_CONFLICT for a duplicate id).
  // The second call must NOT throw and must still return the cancelled result.
  const result2 = await cancelRun(da1, 'run-a');
  assert.ok(result2 !== null, 'second cancel must not throw');
  assert.equal(result2.status, 'cancelled');
  // Only one event was actually created (second was swallowed).
  const events2 = creates1.filter((c) => c.table === 'events');
  assert.equal(events2.length, 1, 'double-cancel: still exactly one event row (ROW_CONFLICT swallowed)');
});

// CR-A replay-window test: simulates the scenario where the run_cancelled event was
// written (with previous_status:'running') but the task_runs status patch has NOT yet
// been applied (crash in the replay window between event write and status patch).
// On re-run, cancelRun must:
//   - Read prev = 'running' (status still unpatched on the run row).
//   - Attempt the event write → ROW_CONFLICT (event already exists with previous_status:'running').
//   - In the catch: apply the status patch (completing the interrupted first run).
//   - Return a successful result.
// The event's previous_status must NEVER be 'cancelled' — it was captured as 'running'
// on the first run and the ROW_CONFLICT ensures the first write is immutable.
test('CR-A: replay window (event written, status not yet patched) — event previous_status stays true prior', async () => {
  // Scenario: run status is STILL 'running' (patch never happened), but the event was
  // already written on the first run with previous_status:'running'.
  // Simulate by using a fake with throwConflictOnEvent=true and pre-seeding the event id.
  const runRows: ControlPlaneRow[] = [
    { rowId: 'run-rw', data: { id: 'run-rw', status: 'running', title: 'RW', priority: 0, repos: ['r'] } },
  ];
  const expectedEventId = `event_${fnv1a64Hex('run-rw|run_cancelled')}`;

  // Build the fake and pre-seed the event id (simulating the first run's event write).
  const replayFake = makeFake(runRows, { throwConflictOnEvent: true });
  // Pre-seed: createRow the event with the correct previous_status:'running' (first run's record).
  await replayFake.da.createRow('events', expectedEventId, {
    id: expectedEventId, run_id: 'run-rw', type: 'run_cancelled',
    payload: { source: 'revo run cancel', previous_status: 'running' },
    actor: 'cli', created_at: '2026-06-08T00:00:00.000Z',
  });

  // Now simulate the replay: run status is still 'running', event already exists (ROW_CONFLICT will fire).
  const result = await cancelRun(replayFake.da, 'run-rw', { now: new Date('2026-06-08T00:00:00.000Z') });

  // The replay must succeed and complete the status patch.
  assert.ok(result !== null, 'replay must not throw');
  assert.equal(result.status, 'cancelled');
  // previousStatus reflects what was read at replay time (still 'running' — not yet patched).
  assert.equal(result.previousStatus, 'running', 'previousStatus must be true prior status, not cancelled');

  // The status patch must have been applied in the ROW_CONFLICT catch (completing the interrupted run).
  const runPatches = replayFake.patches.filter((p) => p.table === 'task_runs');
  assert.equal(runPatches.length, 1, 'replay must apply the status patch exactly once');

  // The event must NOT have been re-written — the pre-seed (first run's record) is the only one.
  // replayFake.creates includes the pre-seed + any replay attempt; both have previous_status:'running'.
  const eventCreates = replayFake.creates.filter((c) => c.table === 'events');
  // All event create attempts (including the pre-seed) must carry previous_status:'running' — never 'cancelled'.
  for (const ev of eventCreates) {
    const evPayload = ev.data.payload as { previous_status: string } | undefined;
    assert.equal(evPayload?.previous_status, 'running', "event previous_status must be 'running', not 'cancelled'");
  }
});

// C1 (0004 review): double-cancel patches task_runs status AT MOST ONCE (2nd call is no-op on run row).
// Uses a stateful fake so the second cancelRun sees the already-cancelled status from the first call.
test('C1: double-cancel patches task_runs at most once (2nd call is no-op on run row)', async () => {
  // The stateful fake applies patchRow changes to its store, so the second cancelRun
  // reads 'cancelled' (set by the first call) and skips the run patch.
  const { da, patches } = makeFake([RUN('running')], { throwConflictOnEvent: true });

  const result1 = await cancelRun(da, 'run-a');
  assert.ok(result1 !== null, 'first cancel must succeed');
  assert.equal(result1.previousStatus, 'running');

  const result2 = await cancelRun(da, 'run-a');
  assert.ok(result2 !== null, 'second cancel must succeed');
  assert.equal(result2.previousStatus, 'cancelled', 'second call sees already-cancelled status');

  // task_runs patched exactly once (the first call only).
  const runPatches = patches.filter((p) => p.table === 'task_runs');
  assert.equal(runPatches.length, 1, 'task_runs must be patched at most once across two cancelRun calls (C1)');
});
