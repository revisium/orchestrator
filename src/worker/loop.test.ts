import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { runWorker, sleep, type WorkerDeps, type WorkerOptions } from './loop.js';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from '../control-plane/data-access.js';
import type { AttemptResult, NewStepSpec } from './runner.js';
import { fakeRow, makeRole, TEST_PROFILE } from './test-fixtures.js';

// ─── tracked fake DA ─────────────────────────────────────────────────────────

function createTrackedDA(opLog: string[]) {
  const store = new Map<string, Map<string, ControlPlaneRow>>();

  function getTable(name: string): Map<string, ControlPlaneRow> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }

  const da: ControlPlaneDataAccess = {
    async assertReady() {},

    async listRows(tbl: string, _opts?: ListRowsOptions) {
      opLog.push(`list:${tbl}`);
      return [...getTable(tbl).values()];
    },

    async getRow(tbl: string, rowId: string) {
      opLog.push(`get:${tbl}`);
      return getTable(tbl).get(rowId) ?? null;
    },

    async createRow(tbl: string, rowId: string, data: Record<string, unknown>) {
      opLog.push(`create:${tbl}`);
      const row = fakeRow(rowId, data);
      getTable(tbl).set(rowId, row);
      return row;
    },

    async updateRow(tbl: string, rowId: string, data: Record<string, unknown>) {
      const row = fakeRow(rowId, data);
      getTable(tbl).set(rowId, row);
      return row;
    },

    async patchRow(tbl: string, rowId: string, patches: PatchOperation[]) {
      opLog.push(`patch:${tbl}`);
      const existing = getTable(tbl).get(rowId);
      if (!existing) throw new Error(`Row not found: ${tbl}/${rowId}`);
      for (const p of patches) {
        if (p.op === 'replace' || p.op === 'add') existing.data[p.path] = p.value;
        else if (p.op === 'remove') delete existing.data[p.path];
      }
      return existing;
    },
  };

  function seedStep(id: string, overrides: Partial<Record<string, unknown>> = {}): void {
    const row = fakeRow(id, {
      id,
      task_id: 'task-1',
      run_id: 'run-1',
      role: 'architect',
      kind: 'plan_run',
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

  function seedTask(id: string): void {
    getTable('tasks').set(id, fakeRow(id, {
      id,
      run_id: 'run-1',
      title: 'Test task',
      scope: '',
      repo_ref: '.',
      status: 'ready',
    }));
  }

  function rows(table: string): ControlPlaneRow[] {
    return [...getTable(table).values()];
  }

  function getRowDirect(table: string, rowId: string): ControlPlaneRow | undefined {
    return getTable(table).get(rowId);
  }

  return { da, seedStep, seedTask, rows, getRowDirect };
}

// ─── factory helpers ─────────────────────────────────────────────────────────

function makeDeps(opLog: string[], agentResult: (role: ReturnType<typeof makeRole>) => AttemptResult) {
  const tracked = createTrackedDA(opLog);

  const deps: WorkerDeps = {
    da: tracked.da,
    loadRole: async (name) => { opLog.push(`loadRole:${name}`); return makeRole(name); },
    loadModelProfile: async (level) => { opLog.push(`loadModelProfile:${level}`); return TEST_PROFILE; },
    runAgent: async ({ role }) => { opLog.push('runAgent'); return agentResult(role); },
  };

  return { deps, tracked };
}

const ONCE_OPTS: WorkerOptions = { workerId: 'test-worker', roles: ['architect', 'developer'], once: true };

// ─── call order ──────────────────────────────────────────────────────────────

test('loop: call order is recover→claim→loadRole/profile→buildContext→startAttempt→runAgent→createSteps→writeResult', async () => {
  const opLog: string[] = [];
  const { deps, tracked } = makeDeps(opLog, (role) => ({
    output: { done: true },
    nextSteps: role.name === 'architect' ? [{ taskId: 'task-1', role: 'developer', kind: 'impl', input: null, modelProfile: 'standard' }] : [],
    costs: [],
    needsHuman: false,
  }));

  tracked.seedStep('step-arch');
  tracked.seedTask('task-1');

  await runWorker(deps, ONCE_OPTS);

  // 1. loadRole happens after all list:steps (recover + claim both call list:steps)
  const loadRoleIdx = opLog.findIndex((op) => op.startsWith('loadRole'));
  const listStepsIndices = opLog.reduce<number[]>((acc, op, i) => (op === 'list:steps' ? [...acc, i] : acc), []);
  assert.ok(listStepsIndices.length >= 2, 'should have at least 2 list:steps calls (recover + claim)');
  const lastListStepsIdx = listStepsIndices.at(-1)!;
  assert.ok(loadRoleIdx > lastListStepsIdx, `loadRole (${loadRoleIdx}) must come after last list:steps (${lastListStepsIdx})`);

  // 2. loadModelProfile after loadRole
  const loadProfileIdx = opLog.findIndex((op) => op.startsWith('loadModelProfile'));
  assert.ok(loadProfileIdx > loadRoleIdx, 'loadModelProfile must come after loadRole');

  // 3. buildContext reads (get:tasks, list:attempts) after loadModelProfile
  const getTasksIdx = opLog.indexOf('get:tasks');
  assert.ok(getTasksIdx > loadProfileIdx, 'buildContext get:tasks must come after loadModelProfile');

  // 4. startAttempt (create:attempts) after buildContext
  const createAttemptsIdx = opLog.indexOf('create:attempts');
  const listAttemptsIdx = opLog.indexOf('list:attempts');
  assert.ok(createAttemptsIdx > listAttemptsIdx, 'startAttempt must come after buildContext list:attempts');

  // 5. runAgent after startAttempt
  const runAgentIdx = opLog.indexOf('runAgent');
  assert.ok(runAgentIdx > createAttemptsIdx, 'runAgent must come after startAttempt');

  // 6. writeResult (patch:attempts then patch:steps) after runAgent
  const firstPatchAttemptsIdx = opLog.indexOf('patch:attempts');
  assert.ok(firstPatchAttemptsIdx > runAgentIdx, 'writeResult patch:attempts must come after runAgent');

  // 7. createSteps (create:steps) BEFORE writeResult's final step patch (terminal safety)
  const createNextStepsIdx = opLog.indexOf('create:steps');
  const lastPatchStepsIdx = opLog.lastIndexOf('patch:steps');
  assert.ok(createNextStepsIdx < lastPatchStepsIdx, 'createSteps must come before writeResult terminal step patch');
});

test('loop: does not branch on role name — same code path for architect and developer', async () => {
  // Verify the loop runs the same sequence of operations for any role name.
  // Role-specific behavior (which nextSteps to return) is entirely in the runner, not the loop.
  // To isolate loop structure, both runs use an identical runner result (same nextSteps).
  const commonNextStep: NewStepSpec = { taskId: 'task-1', role: 'reviewer', kind: 'review', input: null, modelProfile: 'standard' };
  const commonResult = (): AttemptResult => ({ output: {}, nextSteps: [commonNextStep], costs: [], needsHuman: false });

  const archLog: string[] = [];
  const { deps: archDeps, tracked: archTracked } = makeDeps(archLog, commonResult);
  archTracked.seedStep('step-arch', { role: 'architect' });
  archTracked.seedTask('task-1');
  await runWorker(archDeps, ONCE_OPTS);

  const devLog: string[] = [];
  const { deps: devDeps, tracked: devTracked } = makeDeps(devLog, commonResult);
  devTracked.seedStep('step-dev', { role: 'developer' });
  devTracked.seedTask('task-1');
  await runWorker(devDeps, ONCE_OPTS);

  // Strip role-specific values to compare structural call patterns
  const normalise = (log: string[]) => log.map((op) => op.replace(/:(architect|developer|standard)$/, ':ROLE'));
  assert.deepEqual(normalise(archLog), normalise(devLog), 'loop code path must be identical for both roles');
});

// ─── runner error → failStep ──────────────────────────────────────────────────

test('loop: runner error calls failStep', async () => {
  const opLog: string[] = [];
  const { deps, tracked } = makeDeps(opLog, () => { throw new Error('agent exploded'); });

  tracked.seedStep('step-1');
  tracked.seedTask('task-1');

  await runWorker(deps, ONCE_OPTS);

  // failStep patches the attempt (failed) and then the step (ready/dead)
  const patchAttemptsIdx = opLog.indexOf('patch:attempts');
  assert.ok(patchAttemptsIdx > opLog.indexOf('runAgent'), 'patch:attempts after runAgent');

  // Verify no create:steps was called (no nextSteps on error)
  assert.ok(!opLog.includes('create:steps'), 'create:steps must not be called on runner error');
});

// ─── needsHuman → park, no next steps ────────────────────────────────────────

test('loop: needsHuman parks step and creates no next steps', async () => {
  const opLog: string[] = [];
  const { deps, tracked } = makeDeps(opLog, () => ({
    output: { question: 'approve?' },
    nextSteps: [],
    costs: [],
    needsHuman: true,
  }));

  tracked.seedStep('step-1');
  tracked.seedTask('task-1');

  await runWorker(deps, ONCE_OPTS);

  assert.ok(!opLog.includes('create:steps'), 'create:steps must not be called when needsHuman=true');

  // Step should be patched to awaiting_approval
  const stepRow = tracked.getRowDirect('steps', 'step-1');
  assert.equal(stepRow?.data.status, 'awaiting_approval', 'step should be awaiting_approval');
  assert.equal(stepRow?.data.lease_owner, '', 'lease should be cleared');

  // Attempt must not be left 'running' after park
  const attemptRows = tracked.rows('attempts');
  assert.equal(attemptRows.length, 1, 'exactly one attempt row should exist');
  assert.equal(attemptRows[0]?.data.status, 'paused', 'attempt should be paused after needsHuman park');
});

// ─── once returns on idle ─────────────────────────────────────────────────────

test('loop: once returns immediately when no step is claimable', async () => {
  const opLog: string[] = [];
  const { deps } = makeDeps(opLog, () => ({ output: {}, nextSteps: [], costs: [], needsHuman: false }));

  // No steps seeded — loop should claim nothing and return
  await runWorker(deps, ONCE_OPTS);

  assert.ok(!opLog.includes('runAgent'), 'runAgent must not be called when no step is claimable');
});

// ─── invalid idleSleepMs rejected before loop ────────────────────────────────

test('runWorker: rejects negative idleSleepMs before entering the loop', async () => {
  const opLog: string[] = [];
  const { deps } = makeDeps(opLog, () => ({ output: {}, nextSteps: [], costs: [], needsHuman: false }));

  await assert.rejects(
    () => runWorker(deps, { ...ONCE_OPTS, idleSleepMs: -1 }),
    /idleSleepMs/,
    'negative idleSleepMs must be rejected',
  );
  await assert.rejects(
    () => runWorker(deps, { ...ONCE_OPTS, idleSleepMs: Number.NaN }),
    /idleSleepMs/,
    'NaN idleSleepMs must be rejected',
  );
  assert.ok(!opLog.includes('runAgent'), 'runAgent must not be called when idleSleepMs is invalid');
});

// ─── maxCycles counts all processed steps (including failed) ─────────────────

test('loop: all-failing runner stops after maxCycles regardless of step success', async () => {
  const opLog: string[] = [];
  const { deps, tracked } = makeDeps(opLog, () => { throw new Error('always fails'); });

  // max_attempts: 1 → each failure makes the step dead immediately (no backoff re-queue).
  // Two dead steps provide exactly 2 'failed' outcomes for maxCycles to count.
  tracked.seedStep('step-1', { max_attempts: 1 });
  tracked.seedStep('step-2', { max_attempts: 1 });
  tracked.seedTask('task-1');

  await runWorker(deps, {
    workerId: 'test-worker',
    roles: ['architect', 'developer'],
    once: false,
    idleSleepMs: 0,
    maxCycles: 2,
  });

  const runAgentCount = opLog.filter((op) => op === 'runAgent').length;
  assert.equal(runAgentCount, 2, 'all-failing runner with maxCycles=2 must stop after exactly 2 attempts');
});

// ─── handleResult: createSteps before terminal parent patch ──────────────────

test('loop: handleResult creates next steps before making parent step terminal', async () => {
  const opLog: string[] = [];
  const { deps, tracked } = makeDeps(opLog, () => ({
    output: { done: true },
    nextSteps: [{ taskId: 'task-1', role: 'developer', kind: 'impl', input: null, modelProfile: 'standard' }],
    costs: [],
    needsHuman: false,
  }));

  tracked.seedStep('step-arch');
  tracked.seedTask('task-1');

  await runWorker(deps, ONCE_OPTS);

  const createStepsIdx = opLog.indexOf('create:steps');
  const lastPatchStepsIdx = opLog.lastIndexOf('patch:steps');

  assert.ok(createStepsIdx >= 0, 'create:steps must be called when nextSteps is non-empty');
  assert.ok(
    createStepsIdx < lastPatchStepsIdx,
    `createSteps (${createStepsIdx}) must come before writeResult terminal patch:steps (${lastPatchStepsIdx})`,
  );
});

// ─── crash-and-retry idempotency ─────────────────────────────────────────────

test('loop: crash-after-createSteps retry creates children exactly once (idempotent fan-out)', async () => {
  const opLog: string[] = [];
  let attemptsPatched = 0;

  const { da: baseDa, seedStep, seedTask, rows } = createTrackedDA(opLog);

  // Fail the very first patchRow('attempts') to simulate writeResult crashing after createSteps.
  const faultyDa: ControlPlaneDataAccess = {
    assertReady: baseDa.assertReady,
    listRows: baseDa.listRows,
    getRow: baseDa.getRow,
    createRow: baseDa.createRow,
    updateRow: baseDa.updateRow,
    patchRow: async (tbl, rowId, patches) => {
      if (tbl === 'attempts' && attemptsPatched === 0) {
        attemptsPatched++;
        throw new Error('simulated writeResult crash');
      }
      return baseDa.patchRow(tbl, rowId, patches);
    },
  };

  seedStep('step-arch');
  seedTask('task-1');

  const deps: WorkerDeps = {
    da: faultyDa,
    loadRole: async (name) => { opLog.push(`loadRole:${name}`); return makeRole(name); },
    loadModelProfile: async (level) => { opLog.push(`loadModelProfile:${level}`); return TEST_PROFILE; },
    runAgent: async () => ({
      output: { done: true },
      // Use a role not in ONCE_OPTS.roles so the child is never claimed in the second run.
      nextSteps: [{ taskId: 'task-1', role: 'reviewer', kind: 'review', input: null, modelProfile: 'standard' }],
      costs: [],
      needsHuman: false,
    }),
  };

  // First run: createSteps succeeds, writeResult throws → worker crashes.
  await assert.rejects(
    () => runWorker(deps, ONCE_OPTS),
    /simulated writeResult crash/,
  );

  // Second run: recoverInFlight resets the running step to ready → it is re-processed →
  // createSteps uses the same deterministic child IDs and skips already-existing rows.
  await runWorker(deps, ONCE_OPTS);

  const childSteps = rows('steps').filter((r) => r.rowId !== 'step-arch');
  assert.equal(childSteps.length, 1, 'child step must be created exactly once despite crash-and-retry');
});

// ─── sleep abort-listener not accumulated ─────────────────────────────────────

test('sleep: abort listeners are cleaned up after normal timer completion', async () => {
  const ctrl = new AbortController();

  for (let i = 0; i < 20; i++) {
    await sleep(0, ctrl.signal);
  }

  const listeners = getEventListeners(ctrl.signal, 'abort');
  assert.equal(listeners.length, 0, `Expected 0 abort listeners after 20 completed sleeps, got ${listeners.length}`);
});
