import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrismaRuntimeDataAccess } from './prisma-runtime-data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

type FakeRecord = Record<string, unknown> & { id: string; createdAt: Date; updatedAt: Date };

function matchesWhere(record: FakeRecord, where: Record<string, unknown> = {}): boolean {
  for (const [key, expected] of Object.entries(where)) {
    const actual = record[key];
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && 'in' in expected) {
      const values = (expected as { in?: unknown }).in;
      if (!Array.isArray(values) || !values.includes(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function fakeModel() {
  const rows = new Map<string, FakeRecord>();
  return {
    rows,
    async create({ data }: { data: Record<string, unknown> }) {
      const id = String(data.id);
      const now = new Date('2026-07-07T00:00:00.000Z');
      rows.set(id, {
        ...data,
        id,
        createdAt: data.createdAt instanceof Date ? data.createdAt : now,
        updatedAt: data.updatedAt instanceof Date ? data.updatedAt : now,
      } as FakeRecord);
    },
    async findUnique({ where }: { where: { id: string } }) {
      return rows.get(where.id) ?? null;
    },
    async findMany({ where = {}, take = 100 }: { where?: Record<string, unknown>; take?: number }) {
      return [...rows.values()].filter((record) => matchesWhere(record, where)).slice(0, take);
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const current = rows.get(where.id);
      if (!current) throw new Error('not found');
      rows.set(where.id, { ...current, ...data, updatedAt: data.updatedAt instanceof Date ? data.updatedAt : current.updatedAt });
    },
  };
}

function fakePrisma() {
  return {
    taskRun: fakeModel(),
    runTask: fakeModel(),
    runEvent: fakeModel(),
    runAttempt: fakeModel(),
    inboxItem: fakeModel(),
    runOutput: fakeModel(),
    costLedgerEntry: fakeModel(),
  };
}

test('Prisma runtime data access maps step_id data-path filters to Prisma stepId', async () => {
  const calls: unknown[] = [];
  const prisma = {
    runAttempt: {
      async findMany(args: unknown) {
        calls.push(args);
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('attempts', {
    where: { data: { path: 'step_id', equals: 'step-1' } },
  });

  assert.deepEqual(rows, []);
  assert.deepEqual(calls, [{ where: { stepId: 'step-1' }, orderBy: [{ id: 'asc' }], take: 100 }]);
});

test('Prisma runtime data access applies compound data-path filters before pagination', async () => {
  const calls: unknown[] = [];
  const prisma = {
    inboxItem: {
      async findMany(args: unknown) {
        calls.push(args);
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('inbox', {
    first: 20,
    where: {
      AND: [
        { data: { path: 'run_id', equals: 'run-1' } },
        { data: { path: 'status', equals: 'pending' } },
      ],
    },
  });

  assert.deepEqual(rows, []);
  assert.deepEqual(calls, [{
    where: { runId: 'run-1', status: 'pending' },
    orderBy: [{ id: 'asc' }],
    take: 20,
  }]);
});

test('Prisma runtime data access maps data-path in filters to Prisma in predicates', async () => {
  const calls: unknown[] = [];
  const prisma = {
    taskRun: {
      async findMany(args: unknown) {
        calls.push(args);
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('task_runs', {
    where: { data: { path: 'status', in: ['ready', 'running'] } },
  });

  assert.deepEqual(rows, []);
  assert.deepEqual(calls, [{ where: { status: { in: ['ready', 'running'] } }, orderBy: [{ id: 'asc' }], take: 100 }]);
});

test('Prisma runtime data access maps runtime-specific order fields to Prisma columns', async () => {
  const calls: Array<{ table: string; args: unknown }> = [];
  const prisma = {
    runEvent: {
      async findMany(args: unknown) {
        calls.push({ table: 'events', args });
        return [];
      },
    },
    runOutput: {
      async findMany(args: unknown) {
        calls.push({ table: 'run_outputs', args });
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  await access.listRows('events', {
    first: 5,
    orderBy: [{ field: 'sequence', direction: 'desc' }],
  });
  await access.listRows('run_outputs', {
    first: 5,
    orderBy: [{ field: 'ordinal', direction: 'asc' }],
  });
  await access.listRows('run_outputs', {
    first: 5,
    orderBy: [{ field: 'producedAt', direction: 'desc' }],
  });

  assert.deepEqual(calls, [
    { table: 'events', args: { where: {}, orderBy: [{ sequence: 'desc' }, { id: 'desc' }], take: 5 } },
    { table: 'run_outputs', args: { where: {}, orderBy: [{ ordinal: 'asc' }, { id: 'asc' }], take: 5 } },
    { table: 'run_outputs', args: { where: {}, orderBy: [{ producedAt: 'desc' }, { id: 'desc' }], take: 5 } },
  ]);
});

test('Prisma runtime data access returns no rows for unsupported data-path filters', async () => {
  let called = false;
  const prisma = {
    runAttempt: {
      async findMany() {
        called = true;
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('attempts', {
    where: { data: { path: 'unknown_field', equals: 'value' } },
  });

  assert.deepEqual(rows, []);
  assert.equal(called, false);
});

test('Prisma runtime data access returns no rows for data-path filters without a predicate', async () => {
  let called = false;
  const prisma = {
    taskRun: {
      async findMany() {
        called = true;
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('task_runs', {
    where: { data: { path: 'status' } },
  });

  assert.deepEqual(rows, []);
  assert.equal(called, false);
});

test('Prisma runtime data access rejects data-path filters that are invalid for the selected table', async () => {
  let called = false;
  const prisma = {
    taskRun: {
      async findMany() {
        called = true;
        return [];
      },
    },
  };

  const access = createPrismaRuntimeDataAccess(prisma as never);
  const rows = await access.listRows('task_runs', {
    where: { data: { path: 'run_id', equals: 'run-1' } },
  });

  assert.deepEqual(rows, []);
  assert.equal(called, false);
});

test('Prisma runtime data access creates and reads runtime rows through Prisma models', async () => {
  const prisma = fakePrisma();
  const access = createPrismaRuntimeDataAccess(prisma as never);

  const cases = [
    {
      table: 'task_runs' as const,
      id: 'run-1',
      data: {
        title: 'Run',
        description: 'Feature',
        status: 'ready',
        repos: ['.'],
        scope: 'repo',
        priority: 3,
        playbook_id: 'revisium-default',
        pipeline_id: 'feature-development',
        params: { issue: 285 },
        route_decision: { profileId: 'codex-standard' },
        created_by: 'tester',
      },
      expected: { status: 'ready', pipeline_id: 'feature-development' },
    },
    {
      table: 'tasks' as const,
      id: 'task-1',
      data: {
        run_id: 'run-1',
        repo_ref: '.',
        role_hint: 'developer',
        title: 'Implement',
        status: 'ready',
        depends_on: [],
        scope: 'repo',
        priority: 1,
      },
      expected: { run_id: 'run-1', role_hint: 'developer' },
    },
    {
      table: 'events' as const,
      id: 'event-1',
      data: {
        run_id: 'run-1',
        task_id: 'task-1',
        step_id: 'developer',
        type: 'started',
        payload: { ok: true },
        actor: 'system',
      },
      expected: { type: 'started', step_id: 'developer' },
    },
    {
      table: 'attempts' as const,
      id: 'attempt-1',
      data: {
        run_id: 'run-1',
        step_id: 'developer',
        worker_id: 'worker-1',
        attempt_no: 1,
        iteration: 1,
        status: 'succeeded',
        idempotency_key: 'idem-1',
        model_profile: 'codex-standard',
      },
      expected: { step_id: 'developer', status: 'succeeded' },
    },
    {
      table: 'inbox' as const,
      id: 'inbox-1',
      data: {
        kind: 'question',
        run_id: 'run-1',
        task_id: 'task-1',
        step_id: 'developer',
        project_id: 'project-1',
        title: 'Question',
        context: { q: true },
        options: ['approve'],
        status: 'pending',
      },
      expected: { kind: 'question', status: 'pending' },
    },
    {
      table: 'run_outputs' as const,
      id: 'output-1',
      data: {
        run_id: 'run-1',
        node_id: 'developer',
        ordinal: 1,
        name: 'change',
        schema_ref: 'schema:change',
        payload: { files: [] },
        payload_ref: '',
        attempt_id: 'attempt-1',
      },
      expected: { node_id: 'developer', name: 'change' },
    },
    {
      table: 'cost_ledger' as const,
      id: 'cost-1',
      data: {
        run_id: 'run-1',
        step_id: 'developer',
        attempt_id: 'attempt-1',
        model_profile: 'codex-standard',
        input_tokens: 10,
        output_tokens: 20,
        cost_amount: 0.01,
        currency: 'USD',
      },
      expected: { model_profile: 'codex-standard', input_tokens: 10 },
    },
  ];

  for (const item of cases) {
    const created = await access.createRow(item.table, item.id, item.data);
    const found = await access.getRow(item.table, item.id);
    assert.equal(created.rowId, item.id);
    assert.deepEqual(
      Object.fromEntries(Object.keys(item.expected).map((key) => [key, found?.data[key]])),
      item.expected,
      `${item.table}/${item.id} round-trip`,
    );
  }
});

test('Prisma runtime data access patches mutable runtime rows and lists by mapped data path', async () => {
  const prisma = fakePrisma();
  const access = createPrismaRuntimeDataAccess(prisma as never);
  await access.createRow('task_runs', 'run-1', {
    title: 'Run',
    status: 'ready',
    repos: [],
    params: {},
    route_decision: {},
  });

  const patched = await access.patchRow('task_runs', 'run-1', [
    { op: 'replace', path: 'status', value: 'running' },
    { op: 'replace', path: 'route_decision', value: { profileId: 'codex-standard' } },
  ]);
  const listed = await access.listRows('task_runs', {
    where: { data: { path: 'status', equals: 'running' } },
  });

  assert.equal(patched.data.status, 'running');
  assert.deepEqual(patched.data.route_decision, { profileId: 'codex-standard' });
  assert.deepEqual(listed.map((row) => row.rowId), ['run-1']);
});

test('Prisma runtime data access rejects retired steps writes and append-only updates', async () => {
  const prisma = fakePrisma();
  const access = createPrismaRuntimeDataAccess(prisma as never);

  assert.equal(await access.getRow('steps', 'step-1'), null);
  assert.deepEqual(await access.listRows('steps'), []);
  await assert.rejects(
    () => access.createRow('steps', 'step-1', { id: 'step-1' }),
    (err: ControlPlaneError) => err.code === 'VALIDATION_FAILURE',
  );

  await access.createRow('events', 'event-1', {
    run_id: 'run-1',
    step_id: 'developer',
    type: 'started',
    payload: {},
  });
  await assert.rejects(
    () => access.updateRow('events', 'event-1', { type: 'changed' }),
    (err: ControlPlaneError) => err.code === 'VALIDATION_FAILURE',
  );
});
