import test from 'node:test';
import assert from 'node:assert/strict';
import type { RowWhereInputDto } from '@revisium/client';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from './data-access.js';
import {
  claimNextStep,
  startAttempt,
  writeResult,
  createSteps,
  failStep,
  recoverInFlight,
  type NewStep,
} from './steps.js';

// ─── fake ControlPlaneDataAccess ──────────────────────────────

type WriteCall =
  | { op: 'createRow'; table: string; rowId: string }
  | { op: 'patchRow'; table: string; rowId: string };

type ListCall = { table: string; opts: ListRowsOptions | undefined };

function fakeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
}

function createFakeDA() {
  const store = new Map<string, Map<string, ControlPlaneRow>>();
  const writeCalls: WriteCall[] = [];
  const listCalls: ListCall[] = [];

  function getTable(name: string): Map<string, ControlPlaneRow> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }

  const da: ControlPlaneDataAccess = {
    async assertReady() {},

    async listRows(tbl, opts) {
      listCalls.push({ table: tbl, opts });
      return [...getTable(tbl).values()];
    },

    async getRow(tbl, rowId) {
      return getTable(tbl).get(rowId) ?? null;
    },

    async createRow(tbl, rowId, data) {
      writeCalls.push({ op: 'createRow', table: tbl, rowId });
      const row = fakeRow(rowId, data as Record<string, unknown>);
      getTable(tbl).set(rowId, row);
      return row;
    },

    async updateRow(tbl, rowId, data) {
      const row = fakeRow(rowId, data as Record<string, unknown>);
      getTable(tbl).set(rowId, row);
      return row;
    },

    async patchRow(tbl, rowId, patches: PatchOperation[]) {
      writeCalls.push({ op: 'patchRow', table: tbl, rowId });
      const existing = getTable(tbl).get(rowId);
      if (!existing) throw new Error(`Row not found: ${tbl}/${rowId}`);
      for (const p of patches) {
        if (p.op === 'replace' || p.op === 'add') {
          existing.data[p.path] = p.value;
        } else if (p.op === 'remove') {
          delete existing.data[p.path];
        }
      }
      return existing;
    },
  };

  function seedStep(id: string, overrides: Partial<Record<string, unknown>> = {}): void {
    const row = fakeRow(id, {
      id,
      task_id: 'task-1',
      run_id: 'run-1',
      role: 'developer',
      kind: 'code',
      status: 'ready',
      input: null,
      output: null,
      model_profile: 'standard',
      run_after: '',
      attempt_count: 0,
      max_attempts: 3,
      priority: 0,
      lease_owner: '',
      lease_expires_at: '',
      dead_reason: '',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
    getTable('steps').set(id, row);
  }

  function seedAttempt(id: string, overrides: Partial<Record<string, unknown>> = {}): void {
    const row = fakeRow(id, {
      id,
      step_id: 'step-1',
      run_id: 'run-1',
      worker_id: 'worker-1',
      attempt_no: 1,
      status: 'running',
      idempotency_key: `idem_${id}`,
      model_profile: 'standard',
      input_tokens: 0,
      output_tokens: 0,
      lesson: '',
      error: '',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '',
      ...overrides,
    });
    getTable('attempts').set(id, row);
  }

  function rows(table: string): ControlPlaneRow[] {
    return [...getTable(table).values()];
  }

  function getRow(table: string, rowId: string): ControlPlaneRow | undefined {
    return getTable(table).get(rowId);
  }

  return { da, writeCalls, listCalls, seedStep, seedAttempt, rows, getRow };
}

const FIXED_NOW = new Date('2026-06-03T10:00:00.000Z');
const FIXED_SUFFIX = 'testsfx1';

// ─── claimNextStep ───────────────────────────────────────────

test('claimNextStep: highest-priority ready step is claimed', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-low', { priority: 0, created_at: '2026-01-01T00:00:00.000Z' });
  seedStep('step-high', { priority: 5, created_at: '2026-01-01T00:01:00.000Z' });

  const claimed = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(claimed?.id, 'step-high');
  assert.equal(claimed?.status, 'claimed');
});

test('claimNextStep: among equal-priority steps, oldest is claimed', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-newer', { priority: 1, created_at: '2026-01-01T00:02:00.000Z' });
  seedStep('step-older', { priority: 1, created_at: '2026-01-01T00:01:00.000Z' });

  const claimed = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(claimed?.id, 'step-older');
});

test('claimNextStep: future run_after is skipped', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-future', { run_after: '2030-01-01T00:00:00.000Z' });

  const result = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(result, null);
});

test('claimNextStep: wrong role is skipped', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-tester', { role: 'tester' });

  const result = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(result, null);
});

test('claimNextStep: non-ready step is skipped', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-running', { status: 'running' });

  const result = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(result, null);
});

test('claimNextStep: lease fields are written to the step row', async () => {
  const { da, seedStep, getRow } = createFakeDA();
  seedStep('step-1');

  await claimNextStep(da, 'worker-42', ['developer'], {
    now: FIXED_NOW,
    leaseTtlMs: 60_000,
    idSuffix: FIXED_SUFFIX,
  });

  const row = getRow('steps', 'step-1');
  assert.equal(row?.data.status, 'claimed');
  assert.equal(row?.data.lease_owner, 'worker-42');
  assert.equal(typeof row?.data.lease_expires_at, 'string');
  assert.ok(String(row?.data.lease_expires_at) > FIXED_NOW.toISOString());
});

test('claimNextStep: no runnable step returns null', async () => {
  const { da } = createFakeDA();

  const result = await claimNextStep(da, 'worker-1', ['developer'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.equal(result, null);
});

test('claimNextStep: listRows where includes status=ready and role∈roles server-side', async () => {
  const { da, seedStep, listCalls } = createFakeDA();
  seedStep('step-dev', { role: 'developer' });

  await claimNextStep(da, 'worker-1', ['developer', 'tester'], {
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  const stepsCall = listCalls.find((c) => c.table === 'steps');
  assert.ok(stepsCall, 'expected a listRows call on steps');

  const where = stepsCall.opts?.where as RowWhereInputDto | undefined;
  assert.ok(Array.isArray(where?.AND), 'where.AND should be an array');

  const andClauses = where?.AND ?? [];
  const statusClause = andClauses.find((c) => c.data?.path === 'status');
  assert.ok(statusClause, 'AND should include a status clause');
  assert.equal(statusClause.data?.equals, 'ready');

  const roleClause = andClauses.find((c) => Array.isArray(c.OR));
  assert.ok(roleClause, 'AND should include an OR clause for roles');
  const rolePaths = (roleClause.OR ?? []).map((r) => String(r.data?.equals));
  assert.ok(rolePaths.includes('developer'));
  assert.ok(rolePaths.includes('tester'));
});

// ─── startAttempt ────────────────────────────────────────────

test('startAttempt: creates attempt row with running status before flipping step', async () => {
  const { da, seedStep, writeCalls, getRow } = createFakeDA();
  seedStep('step-1');
  const stepRows = (await da.listRows('steps')).map((r) => ({
    id: r.rowId,
    taskId: String(r.data.task_id),
    runId: String(r.data.run_id),
    role: String(r.data.role),
    kind: String(r.data.kind),
    status: String(r.data.status),
    input: r.data.input,
    output: r.data.output,
    modelProfile: String(r.data.model_profile),
    runAfter: String(r.data.run_after),
    attemptCount: Number(r.data.attempt_count),
    maxAttempts: Number(r.data.max_attempts),
    priority: Number(r.data.priority),
    leaseOwner: String(r.data.lease_owner),
    leaseExpiresAt: String(r.data.lease_expires_at),
    deadReason: String(r.data.dead_reason),
  }));
  assert.ok(stepRows.length > 0, 'expected at least one step row');
  const step = stepRows[0];

  const { attemptId, idempotencyKey } = await startAttempt(da, step, {
    workerId: 'worker-1',
    now: FIXED_NOW,
    idSuffix: FIXED_SUFFIX,
  });

  assert.ok(attemptId.startsWith('attempt_'));
  assert.ok(idempotencyKey.startsWith('idem_'));

  // attempt row created before step patch
  const createIdx = writeCalls.findIndex((c) => c.op === 'createRow' && c.table === 'attempts');
  const patchIdx = writeCalls.findIndex((c) => c.op === 'patchRow' && c.table === 'steps');
  assert.ok(createIdx >= 0 && patchIdx > createIdx, 'attempt created before step patched');

  const attemptRow = getRow('attempts', attemptId);
  assert.equal(attemptRow?.data.status, 'running');
  assert.equal(attemptRow?.data.attempt_no, 1);
  assert.equal(attemptRow?.data.worker_id, 'worker-1');

  const stepRow = getRow('steps', 'step-1');
  assert.equal(stepRow?.data.status, 'running');
});

test('startAttempt: returns distinct attemptId and idempotencyKey', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-1');
  const rows = await da.listRows('steps');
  assert.ok(rows.length > 0, 'expected at least one step row');
  const step = {
    id: rows[0].rowId,
    taskId: String(rows[0].data.task_id),
    runId: String(rows[0].data.run_id),
    role: String(rows[0].data.role),
    kind: String(rows[0].data.kind),
    status: 'claimed',
    input: null,
    output: null,
    modelProfile: 'standard',
    runAfter: '',
    attemptCount: 0,
    maxAttempts: 3,
    priority: 0,
    leaseOwner: 'worker-1',
    leaseExpiresAt: '',
    deadReason: '',
  };

  const r = await startAttempt(da, step, { workerId: 'worker-1', now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.notEqual(r.attemptId, r.idempotencyKey);
});

// ─── writeResult ─────────────────────────────────────────────

test('writeResult: step status flip happens after attempt, event, and cost writes', async () => {
  const { da, seedStep, seedAttempt, writeCalls } = createFakeDA();
  seedStep('step-1', { status: 'running' });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 1, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await writeResult(da, step, 'attempt-1', { done: true }, [
    { modelProfile: 'standard', inputTokens: 100, outputTokens: 50, costAmount: 0.01 },
  ], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const stepPatchIdx = writeCalls.findLastIndex((c) => c.op === 'patchRow' && c.table === 'steps');
  const attemptPatchIdx = writeCalls.findIndex((c) => c.op === 'patchRow' && c.table === 'attempts');
  const eventCreateIdx = writeCalls.findIndex((c) => c.op === 'createRow' && c.table === 'events');
  const costCreateIdx = writeCalls.findIndex((c) => c.op === 'createRow' && c.table === 'cost_ledger');

  assert.ok(attemptPatchIdx < stepPatchIdx, 'attempt closed before step flipped');
  assert.ok(eventCreateIdx < stepPatchIdx, 'event written before step flipped');
  assert.ok(costCreateIdx < stepPatchIdx, 'cost written before step flipped');
});

test('writeResult: empty costs write no cost_ledger rows', async () => {
  const { da, seedStep, seedAttempt, rows } = createFakeDA();
  seedStep('step-1', { status: 'running' });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 1, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await writeResult(da, step, 'attempt-1', null, [], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.equal(rows('cost_ledger').length, 0);
});

test('writeResult: step is succeeded and output is set', async () => {
  const { da, seedStep, seedAttempt, getRow } = createFakeDA();
  seedStep('step-1', { status: 'running' });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 1, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await writeResult(da, step, 'attempt-1', { result: 'ok' }, [], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const row = getRow('steps', 'step-1');
  assert.equal(row?.data.status, 'succeeded');
  assert.deepEqual(row?.data.output, { result: 'ok' });
});

// ─── createSteps ─────────────────────────────────────────────

test('createSteps: inserts ready step when no dependsOn', async () => {
  const { da, rows } = createFakeDA();
  const ns: NewStep = {
    taskId: 'task-1', runId: 'run-1', role: 'tester', kind: 'test',
    input: { target: 'lib' }, modelProfile: 'cheap',
  };

  await createSteps(da, [ns], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const created = rows('steps');
  assert.equal(created.length, 1);
  assert.equal(created[0]?.data.status, 'ready');
  assert.equal(created[0]?.data.role, 'tester');
  assert.equal(created[0]?.data.attempt_count, 0);
});

test('createSteps: inserts pending step when dependsOn is non-empty', async () => {
  const { da, rows } = createFakeDA();
  const ns: NewStep = {
    taskId: 'task-1', runId: 'run-1', role: 'reviewer', kind: 'review',
    input: null, modelProfile: 'standard', dependsOn: ['step-prev'],
  };

  await createSteps(da, [ns], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const created = rows('steps');
  assert.equal(created[0]?.data.status, 'pending');
});

test('createSteps: never creates attempt rows', async () => {
  const { da, rows } = createFakeDA();
  await createSteps(da, [
    { taskId: 't', runId: 'r', role: 'developer', kind: 'code', input: null, modelProfile: 'standard' },
  ], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.equal(rows('attempts').length, 0);
});

// ─── failStep ────────────────────────────────────────────────

test('failStep: under max attempts, step is reset to ready with future run_after', async () => {
  const { da, seedStep, seedAttempt, getRow } = createFakeDA();
  seedStep('step-1', { status: 'running', attempt_count: 0, max_attempts: 3 });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 0, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await failStep(da, step, 'attempt-1', {
    lesson: 'tests failed', now: FIXED_NOW, idSuffix: FIXED_SUFFIX,
  });

  const row = getRow('steps', 'step-1');
  assert.equal(row?.data.status, 'ready');
  assert.equal(row?.data.attempt_count, 1);
  assert.ok(String(row?.data.run_after) > FIXED_NOW.toISOString(), 'run_after is in the future');
});

test('failStep: at max attempts, step becomes dead', async () => {
  const { da, seedStep, seedAttempt, getRow } = createFakeDA();
  seedStep('step-1', { status: 'running', attempt_count: 0, max_attempts: 1 });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 0, maxAttempts: 1, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await failStep(da, step, 'attempt-1', {
    lesson: 'fatal error', now: FIXED_NOW, idSuffix: FIXED_SUFFIX,
  });

  const row = getRow('steps', 'step-1');
  assert.equal(row?.data.status, 'dead');
  assert.equal(row?.data.attempt_count, 1);
  assert.ok(String(row?.data.dead_reason).length > 0, 'dead_reason is set');
});

test('failStep: attempt is closed as failed', async () => {
  const { da, seedStep, seedAttempt, getRow } = createFakeDA();
  seedStep('step-1', { status: 'running', attempt_count: 0, max_attempts: 3 });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 0, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
    leaseExpiresAt: '', deadReason: '',
  };

  await failStep(da, step, 'attempt-1', {
    lesson: 'build error', error: 'exit code 1', now: FIXED_NOW, idSuffix: FIXED_SUFFIX,
  });

  const row = getRow('attempts', 'attempt-1');
  assert.equal(row?.data.status, 'failed');
  assert.equal(row?.data.lesson, 'build error');
});

// ─── recoverInFlight ─────────────────────────────────────────

test('recoverInFlight: resets claimed step owned by this worker to ready', async () => {
  const { da, seedStep, getRow } = createFakeDA();
  seedStep('step-claimed', { status: 'claimed', lease_owner: 'worker-A' });

  await recoverInFlight(da, 'worker-A', { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const row = getRow('steps', 'step-claimed');
  assert.equal(row?.data.status, 'ready');
  assert.equal(row?.data.lease_owner, '');
  assert.equal(row?.data.lease_expires_at, '');
});

test('recoverInFlight: resets running step and closes its running attempt', async () => {
  const { da, seedStep, seedAttempt, getRow } = createFakeDA();
  seedStep('step-running', { status: 'running', lease_owner: 'worker-A' });
  seedAttempt('attempt-running', { step_id: 'step-running', status: 'running', worker_id: 'worker-A' });

  await recoverInFlight(da, 'worker-A', { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const stepRow = getRow('steps', 'step-running');
  assert.equal(stepRow?.data.status, 'ready');

  const attemptRow = getRow('attempts', 'attempt-running');
  assert.equal(attemptRow?.data.status, 'failed');
  assert.equal(attemptRow?.data.lesson, 'worker crashed mid-step');
});

test('recoverInFlight: ignores steps owned by other workers', async () => {
  const { da, seedStep, getRow } = createFakeDA();
  seedStep('step-other', { status: 'claimed', lease_owner: 'worker-B' });

  const recovered = await recoverInFlight(da, 'worker-A', { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.equal(recovered.length, 0);
  const row = getRow('steps', 'step-other');
  assert.equal(row?.data.status, 'claimed');
});

test('recoverInFlight: returns the recovered steps', async () => {
  const { da, seedStep } = createFakeDA();
  seedStep('step-1', { status: 'claimed', lease_owner: 'worker-A' });
  seedStep('step-2', { status: 'running', lease_owner: 'worker-A' });
  seedStep('step-3', { status: 'ready', lease_owner: '' });

  const recovered = await recoverInFlight(da, 'worker-A', { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  assert.equal(recovered.length, 2);
  assert.ok(recovered.some((s) => s.id === 'step-1'));
  assert.ok(recovered.some((s) => s.id === 'step-2'));
});
