import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createRunWorkflow,
  CreateRunWorkflowError,
  KNOWN_ROLES,
  type CreateRunInput,
  type CreateRunResult,
} from './create-run.js';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';

type CreatedRow = {
  table: RuntimeTable;
  rowId: string;
  data: Record<string, unknown>;
};

function row(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data };
}

function createFakeDataAccess(options: { assertReadyError?: Error; failAt?: RuntimeTable } = {}): {
  access: ControlPlaneDataAccess;
  calls: string[];
  rows: CreatedRow[];
} {
  const calls: string[] = [];
  const rows: CreatedRow[] = [];
  const access: ControlPlaneDataAccess = {
    async assertReady() {
      calls.push('assertReady');
      if (options.assertReadyError) throw options.assertReadyError;
    },
    async listRows(_table: RuntimeTable, _options?: ListRowsOptions) {
      return [];
    },
    async getRow(_table: RuntimeTable, _rowId: string) {
      return null;
    },
    async createRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>) {
      calls.push(`create:${table}`);
      if (options.failAt === table) throw new Error(`failed at ${table}`);
      rows.push({ table, rowId, data });
      return row(rowId, data);
    },
    async updateRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>) {
      return row(rowId, data);
    },
    async patchRow(table: RuntimeTable, rowId: string, _patches: PatchOperation[]) {
      return row(rowId, { id: rowId, table });
    },
  };
  return { access, calls, rows };
}

const baseInput: CreateRunInput = {
  title: 'Implement Plan 0003!',
  repo: 'agent-orchestrator',
  description: 'Create run workflow',
  scope: 'plan 0003',
  priority: 2,
  now: new Date('2026-06-01T02:03:04.005Z'),
  idSuffix: 'abc123ef',
};

function byTable(rows: CreatedRow[], table: RuntimeTable): CreatedRow {
  const found = rows.find((created) => created.table === table);
  assert.ok(found, `missing row for ${table}`);
  return found;
}

test('creates run, task, step, and event rows in order after assertReady', async () => {
  const { access, calls, rows } = createFakeDataAccess();

  const result = await createRunWorkflow(access, baseInput);

  assert.deepEqual(calls, ['assertReady', 'create:task_runs', 'create:tasks', 'create:steps', 'create:events']);
  assert.deepEqual(
    rows.map(({ table }) => table),
    ['task_runs', 'tasks', 'steps', 'events'],
  );
  assert.deepEqual(result, {
    runId: 'run_20260601T020304005Z_implement-plan-0003_abc123ef',
    taskId: 'task_20260601T020304005Z_implement-plan-0003_abc123ef',
    stepId: 'step_20260601T020304005Z_implement-plan-0003_abc123ef',
    eventId: 'event_20260601T020304005Z_implement-plan-0003_abc123ef_created',
    status: 'ready',
  });
});

test('writes the exact ready skeleton fields without stringifying JSON-ish values', async () => {
  const { access, rows } = createFakeDataAccess();

  const result = await createRunWorkflow(access, baseInput);

  assert.equal(byTable(rows, 'task_runs').data.status, 'ready');
  assert.equal(byTable(rows, 'tasks').data.status, 'ready');

  const step = byTable(rows, 'steps').data;
  assert.equal(step.status, 'ready');
  assert.equal(step.kind, 'plan_run');
  assert.equal(step.role, 'architect');
  assert.equal(step.model_profile, 'standard');
  assert.equal(typeof step.input, 'object');
  assert.equal(step.output, null);
  assert.deepEqual(step.input, {
    title: 'Implement Plan 0003!',
    description: 'Create run workflow',
    scope: 'plan 0003',
    repo: { input: 'agent-orchestrator', ref: 'agent-orchestrator', mode: 'name' },
    run_id: result.runId,
    task_id: result.taskId,
  });

  const event = byTable(rows, 'events').data;
  assert.equal(event.type, 'run_created');
  assert.equal(typeof event.payload, 'object');
  assert.deepEqual(event.payload, {
    source: 'revo run create',
    title: 'Implement Plan 0003!',
    description: 'Create run workflow',
    scope: 'plan 0003',
    repo: { input: 'agent-orchestrator', ref: 'agent-orchestrator', mode: 'name' },
    priority: 2,
    playbook_id: '',
    pipeline_id: '',
    route_decision: {},
    execution_profile: {},
    ids: { run_id: result.runId, task_id: result.taskId, step_id: result.stepId },
  });
});

test('defaults optional inputs and accepts plain repo names unchanged', async () => {
  const { access, rows } = createFakeDataAccess();

  await createRunWorkflow(access, {
    title: 'Defaults',
    repo: 'repo-name',
    now: baseInput.now,
    idSuffix: baseInput.idSuffix,
  });

  const run = byTable(rows, 'task_runs').data;
  assert.equal(run.description, '');
  assert.equal(run.scope, '');
  assert.equal(run.priority, 0);
  assert.deepEqual(run.repos, ['repo-name']);
});

test('validates title, repo, and priority before assertReady or writes', async () => {
  for (const input of [
    { ...baseInput, title: '   ' },
    { ...baseInput, repo: '   ' },
    { ...baseInput, priority: Number.NaN },
    { ...baseInput, priority: 1.5 },
  ]) {
    const { access, calls, rows } = createFakeDataAccess();
    await assert.rejects(() => createRunWorkflow(access, input), Error);
    assert.deepEqual(calls, []);
    assert.deepEqual(rows, []);
  }
});

test('assertReady failure writes zero rows', async () => {
  const { access, calls, rows } = createFakeDataAccess({ assertReadyError: new Error('not ready') });

  await assert.rejects(() => createRunWorkflow(access, baseInput), /not ready/);

  assert.deepEqual(calls, ['assertReady']);
  assert.deepEqual(rows, []);
});

test('existing relative directory becomes absolute repoRef and structured path metadata', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'revo-run-'));
  const relative = path.relative(process.cwd(), tempDir);
  const { access, rows } = createFakeDataAccess();

  await createRunWorkflow(access, { ...baseInput, repo: relative });

  assert.deepEqual(byTable(rows, 'task_runs').data.repos, [tempDir]);
  assert.equal(byTable(rows, 'tasks').data.repo_ref, tempDir);
  assert.deepEqual((byTable(rows, 'steps').data.input as { repo: unknown }).repo, {
    input: relative,
    ref: tempDir,
    mode: 'path',
  });
});

test('explicit missing paths fail before writes', async () => {
  const { access, calls, rows } = createFakeDataAccess();

  await assert.rejects(() => createRunWorkflow(access, { ...baseInput, repo: './missing-repo-path' }), /repo path/);

  assert.deepEqual(calls, []);
  assert.deepEqual(rows, []);
});

test('simulated later write failures report partial IDs and do not rollback', async () => {
  const { access } = createFakeDataAccess({ failAt: 'steps' });

  await assert.rejects(
    () => createRunWorkflow(access, baseInput),
    (error: unknown) => {
      assert.ok(error instanceof CreateRunWorkflowError);
      assert.deepEqual(error.createdIds, {
        runId: 'run_20260601T020304005Z_implement-plan-0003_abc123ef',
        taskId: 'task_20260601T020304005Z_implement-plan-0003_abc123ef',
      });
      return true;
    },
  );
});

test('repeated calls with different suffixes create distinct row IDs', async () => {
  const { access } = createFakeDataAccess();

  const first: CreateRunResult = await createRunWorkflow(access, { ...baseInput, idSuffix: '11111111' });
  const second: CreateRunResult = await createRunWorkflow(access, { ...baseInput, idSuffix: '22222222' });

  assert.notEqual(first.runId, second.runId);
  assert.notEqual(first.taskId, second.taskId);
  assert.notEqual(first.stepId, second.stepId);
  assert.notEqual(first.eventId, second.eventId);
});

test('long titles keep generated event IDs within the endpoint row-id limit', async () => {
  const { access } = createFakeDataAccess();

  const result = await createRunWorkflow(access, {
    ...baseInput,
    title: 'Smoke create run 1780247165629 with extra detail',
  });

  assert.ok(result.eventId.length <= 64);
  assert.equal(result.eventId, 'event_20260601T020304005Z_smoke-create-run-1780_abc123ef_created');
});

test('role override applies to both tasks.role_hint and steps.role', async () => {
  const { access, rows } = createFakeDataAccess();

  await createRunWorkflow(access, { ...baseInput, role: 'developer' });

  assert.equal(byTable(rows, 'tasks').data.role_hint, 'developer');
  assert.equal(byTable(rows, 'steps').data.role, 'developer');
});

test('omitting role defaults both fields to architect', async () => {
  const { access, rows } = createFakeDataAccess();

  await createRunWorkflow(access, { ...baseInput, role: undefined });

  assert.equal(byTable(rows, 'tasks').data.role_hint, 'architect');
  assert.equal(byTable(rows, 'steps').data.role, 'architect');
});

test('unsafe or unknown bare role rejects before assertReady or writes', async () => {
  const { access, calls, rows } = createFakeDataAccess();

  await assert.rejects(() => createRunWorkflow(access, { ...baseInput, role: 'tester' }), /role must be/);
  assert.deepEqual(calls, []);
  assert.deepEqual(rows, []);
});

test('each known role is accepted and written to steps.role', async () => {
  for (const knownRole of KNOWN_ROLES) {
    const { access, rows } = createFakeDataAccess();
    await createRunWorkflow(access, { ...baseInput, role: knownRole });
    assert.equal(byTable(rows, 'steps').data.role, knownRole);
  }
});

test('installed playbook role row ids are accepted and written to role fields', async () => {
  const { access, rows } = createFakeDataAccess();

  await createRunWorkflow(access, { ...baseInput, role: 'pb-developer' });

  assert.equal(byTable(rows, 'tasks').data.role_hint, 'pb-developer');
  assert.equal(byTable(rows, 'steps').data.role, 'pb-developer');
});

test('unsafe installed role row ids reject before assertReady or writes', async () => {
  for (const role of ['pb/developer', 'pb developer', 'x'.repeat(65)]) {
    const { access, calls, rows } = createFakeDataAccess();
    await assert.rejects(() => createRunWorkflow(access, { ...baseInput, role }), /role must be/);
    assert.deepEqual(calls, []);
    assert.deepEqual(rows, []);
  }
});
