import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from './data-access.js';
import { ControlPlaneError } from './errors.js';
import {
  claimNextStep,
  startAttempt,
  writeResult,
  createSteps,
  failStep,
  recoverInFlight,
  toStr,
  type Step,
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
      if (getTable(tbl).has(rowId)) {
        throw new ControlPlaneError('ROW_CONFLICT', `Row already exists: ${tbl}/${rowId}`);
      }
      writeCalls.push({ op: 'createRow', table: tbl, rowId });
      const row = fakeRow(rowId, data);
      getTable(tbl).set(rowId, row);
      return row;
    },

    async updateRow(tbl, rowId, data) {
      const row = fakeRow(rowId, data);
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

// Rebuild a Step from its persisted row, mirroring production mapStep. Uses the exported toStr
// (typeof-guarded) instead of coercing with String + a nullish fallback, so an object-valued field
// can never stringify to a default object representation (Sonar S6551). Simulates a worker
// refetching the step from the control plane.
function stepFromRow(
  getRow: (table: string, rowId: string) => ControlPlaneRow | undefined,
  rowId: string,
): Step {
  const r = getRow('steps', rowId);
  if (!r) throw new Error(`row not found: ${rowId}`);
  return {
    id: r.rowId,
    taskId: toStr(r.data.task_id),
    runId: toStr(r.data.run_id),
    role: toStr(r.data.role),
    kind: toStr(r.data.kind),
    status: toStr(r.data.status),
    input: r.data.input ?? null,
    output: r.data.output ?? null,
    modelProfile: toStr(r.data.model_profile),
    runAfter: toStr(r.data.run_after),
    attemptCount: Number(r.data.attempt_count ?? 0),
    maxAttempts: Number(r.data.max_attempts ?? 3),
    priority: Number(r.data.priority ?? 0),
    leaseOwner: toStr(r.data.lease_owner),
    leaseExpiresAt: toStr(r.data.lease_expires_at),
    deadReason: toStr(r.data.dead_reason),
  };
}

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

  const where = stepsCall.opts?.where;
  assert.ok(Array.isArray(where?.AND), 'where.AND should be an array');

  const andClauses = where?.AND ?? [];
  const statusClause = andClauses.find((c) => c.data?.path === 'status');
  assert.ok(statusClause, 'AND should include a status clause');
  assert.equal(statusClause.data?.equals, 'ready');

  const roleClause = andClauses.find((c) => Array.isArray(c.OR));
  assert.ok(roleClause, 'AND should include an OR clause for roles');
  const rolePaths = new Set((roleClause.OR ?? []).map((r) => String(r.data?.equals)));
  assert.ok(rolePaths.has('developer'));
  assert.ok(rolePaths.has('tester'));
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

test('createSteps: depends_on is persisted on the row', async () => {
  const { da, rows } = createFakeDA();
  await createSteps(da, [
    {
      taskId: 't', runId: 'r', role: 'reviewer', kind: 'review', input: null,
      modelProfile: 'standard', dependsOn: ['step-a', 'step-b'],
    },
    {
      taskId: 't', runId: 'r', role: 'developer', kind: 'code', input: null,
      modelProfile: 'standard',
    },
  ], { now: FIXED_NOW, idSuffix: FIXED_SUFFIX });

  const created = rows('steps');
  const withDeps = created.find((r) => r.data.role === 'reviewer');
  const noDeps = created.find((r) => r.data.role === 'developer');

  assert.deepEqual(withDeps?.data.depends_on, ['step-a', 'step-b']);
  assert.equal(withDeps?.data.status, 'pending');
  assert.deepEqual(noDeps?.data.depends_on, []);
  assert.equal(noDeps?.data.status, 'ready');
});

test('createSteps: with parentStepId, child IDs are deterministic (same parent → same ID on repeated calls)', async () => {
  const { da, rows } = createFakeDA();
  const ns: NewStep = {
    taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'impl', input: null, modelProfile: 'standard',
  };

  await createSteps(da, [ns], { parentStepId: 'step-parent-1', now: FIXED_NOW });

  const created = rows('steps');
  assert.equal(created.length, 1);
  const childId = created[0]?.rowId ?? '';
  assert.ok(childId.startsWith('step-parent-1_ch_'), 'child ID starts with parentStepId_ch_');
  assert.ok(childId.endsWith('_0'), 'first child has _0 index suffix');
  assert.equal(childId, 'step-parent-1_ch_0', 'child ID is parentStepId_ch_index');
});

test('createSteps: with parentStepId, repeated calls for the same parent are idempotent (no duplicate children)', async () => {
  const { da, rows } = createFakeDA();
  const ns: NewStep = {
    taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'impl', input: null, modelProfile: 'standard',
  };

  await createSteps(da, [ns], { parentStepId: 'step-parent-1', now: FIXED_NOW });
  await createSteps(da, [ns], { parentStepId: 'step-parent-1', now: FIXED_NOW });

  const created = rows('steps');
  assert.equal(created.length, 1, 'second createSteps call with same parentStepId must be a no-op');
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
  // attempt_count=1: startAttempt already counted the in-flight attempt; failStep gates on it.
  seedStep('step-1', { status: 'running', attempt_count: 1, max_attempts: 3 });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 1, maxAttempts: 3, priority: 0, leaseOwner: 'worker-1',
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
  // attempt_count=1 of max 1: startAttempt counted the only allowed attempt, so this fail is fatal.
  seedStep('step-1', { status: 'running', attempt_count: 1, max_attempts: 1 });
  seedAttempt('attempt-1', { step_id: 'step-1' });

  const step = {
    id: 'step-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'code',
    status: 'running', input: null, output: null, modelProfile: 'standard', runAfter: '',
    attemptCount: 1, maxAttempts: 1, priority: 0, leaseOwner: 'worker-1',
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

test('failStep: attempt_count accounting across start→fail cycles reaches correct gate', async () => {
  const { da, seedStep, getRow } = createFakeDA();
  seedStep('step-1', { status: 'ready', attempt_count: 0, max_attempts: 2, lease_owner: 'w1', lease_expires_at: 'x' });

  // First attempt: startAttempt must write attempt_count immediately
  const step0 = stepFromRow(getRow, 'step-1');
  const { attemptId: aid1 } = await startAttempt(da, step0, { workerId: 'w1', now: FIXED_NOW, idSuffix: 'sfx1' });
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 1, 'attempt_count=1 after first startAttempt');

  await failStep(da, step0, aid1, { lesson: 'first fail', now: FIXED_NOW, idSuffix: 'sfx2' });
  assert.equal(getRow('steps', 'step-1')?.data.status, 'ready', 'step retries after first fail');
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 1);

  // Second attempt: re-read step so attemptCount=1
  const step1 = stepFromRow(getRow, 'step-1');
  assert.equal(step1.attemptCount, 1, 'step1.attemptCount reflects first attempt');
  const { attemptId: aid2 } = await startAttempt(da, step1, { workerId: 'w1', now: FIXED_NOW, idSuffix: 'sfx3' });
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 2, 'attempt_count=2 after second startAttempt');

  await failStep(da, step1, aid2, { lesson: 'second fail', now: FIXED_NOW, idSuffix: 'sfx4' });
  assert.equal(getRow('steps', 'step-1')?.data.status, 'dead', 'step is dead after exhausting max_attempts=2');
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 2);
  assert.equal(getRow('steps', 'step-1')?.data.lease_owner, '', 'lease cleared on dead');
});

test('failStep: refetch between startAttempt and failStep still dies at exactly max_attempts', async () => {
  // Regression for the double-count bug: failStep must gate on the PERSISTED attempt_count, not on
  // the caller's snapshot. A worker that refetched the step AFTER startAttempt holds the already-
  // incremented value; deriving snapshot+1 from it would kill the step one attempt early.
  const { da, seedStep, getRow } = createFakeDA();
  seedStep('step-1', { status: 'ready', attempt_count: 0, max_attempts: 2, lease_owner: 'w1', lease_expires_at: 'x' });

  // Attempt 1: start, then refetch the step (attempt_count is now 1) before failing it.
  const claimed1 = stepFromRow(getRow, 'step-1');
  const { attemptId: aid1 } = await startAttempt(da, claimed1, { workerId: 'w1', now: FIXED_NOW, idSuffix: 'sfx1' });
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 1, 'startAttempt owns the increment');
  const refetched1 = stepFromRow(getRow, 'step-1');
  assert.equal(refetched1.attemptCount, 1, 'refetched snapshot carries the already-incremented count');

  await failStep(da, refetched1, aid1, { lesson: 'fail 1', now: FIXED_NOW, idSuffix: 'sfx2' });
  // snapshot+1 would be 2 >= max(2) → dead one attempt early; persisted gate (1 < 2) keeps it retryable.
  assert.equal(getRow('steps', 'step-1')?.data.status, 'ready', 'still retryable, not dead one attempt early');
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 1, 'failStep does not re-write attempt_count');

  // Attempt 2: start (→2), refetch again, then fail → now exactly at the cap → dead.
  const claimed2 = stepFromRow(getRow, 'step-1');
  const { attemptId: aid2 } = await startAttempt(da, claimed2, { workerId: 'w1', now: FIXED_NOW, idSuffix: 'sfx3' });
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 2, 'attempt_count=2 after second startAttempt');
  const refetched2 = stepFromRow(getRow, 'step-1');

  await failStep(da, refetched2, aid2, { lesson: 'fail 2', now: FIXED_NOW, idSuffix: 'sfx4' });
  assert.equal(getRow('steps', 'step-1')?.data.status, 'dead', 'dead at exactly max_attempts=2');
  assert.equal(getRow('steps', 'step-1')?.data.attempt_count, 2);
  assert.equal(getRow('steps', 'step-1')?.data.lease_owner, '', 'lease cleared on dead');
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
