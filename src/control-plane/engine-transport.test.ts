import test from 'node:test';
import assert from 'node:assert/strict';
import type { EngineApiService } from '@revisium/engine';
import type { RevoPrismaService } from '../storage/revo-prisma.service.js';
import { ControlPlaneError } from './errors.js';
import {
  applyEngineBootstrapTables,
  createEngineTransport,
  createEngineVersionedMeaningScope,
  ensureControlPlaneProject,
} from './engine-transport.js';
import { controlPlaneMeaningTables } from './tables.js';

type Call = { name: string; args: unknown };
type PrismaKnownError = Error & {
  code?: string;
  meta?: { modelName?: string };
};
type PrismaOptions =
  | boolean
  | {
      existingBranch?: boolean;
      branchCreateError?: unknown;
      branchExistsAfterBranchCreateError?: boolean;
    };

function branchUniqueConstraintError(): PrismaKnownError {
  const error = new Error(
    'Unique constraint failed on the fields: (`name`, `"projectId"`)',
  ) as PrismaKnownError;
  error.code = 'P2002';
  error.meta = { modelName: 'Branch' };
  return error;
}

function makePrisma(options: PrismaOptions = false) {
  const opts =
    typeof options === 'boolean' ? { existingBranch: options } : options;
  const calls: Call[] = [];
  let branchExists = opts.existingBranch ?? false;
  const tx = {
    branch: {
      async findUnique(args: unknown) {
        calls.push({ name: 'tx.branch.findUnique', args });
        return branchExists ? { id: 'branch-1' } : null;
      },
      async create(args: { data: { id: string } }) {
        calls.push({ name: 'tx.branch.create', args });
        if (opts.branchCreateError) {
          branchExists = opts.branchExistsAfterBranchCreateError ?? branchExists;
          throw opts.branchCreateError;
        }
        branchExists = true;
        return { id: args.data.id };
      },
    },
    revision: {
      async create(args: unknown) {
        calls.push({ name: 'tx.revision.create', args });
        return args;
      },
    },
    table: {
      async create(args: unknown) {
        calls.push({ name: 'tx.table.create', args });
        return args;
      },
    },
  };
  return {
    calls,
    revoProject: {
      async upsert(args: unknown) {
        calls.push({ name: 'revoProject.upsert', args });
        return args;
      },
    },
    branch: {
      async findUnique(args: unknown) {
        calls.push({ name: 'branch.findUnique', args });
        return branchExists ? { id: 'branch-1' } : null;
      },
    },
    async $transaction(callback: (transaction: typeof tx) => Promise<void>) {
      calls.push({ name: '$transaction', args: {} });
      await callback(tx);
    },
  };
}

function makeEngine(
  overrides: Partial<
    Record<keyof EngineApiService, (...args: never[]) => unknown>
  > = {},
) {
  const calls: Call[] = [];
  const engine = {
    calls,
    async getBranch(args: unknown) {
      calls.push({ name: 'getBranch', args });
      return { id: 'branch-1' };
    },
    async getDraftRevision(args: unknown) {
      calls.push({ name: 'getDraftRevision', args });
      return { id: 'draft-1' };
    },
    async getHeadRevision(args: unknown) {
      calls.push({ name: 'getHeadRevision', args });
      return { id: 'head-1' };
    },
    async getTables(args: unknown) {
      calls.push({ name: 'getTables', args });
      return { edges: controlPlaneMeaningTables.map((id) => ({ node: { id } })) };
    },
    async getRows(args: unknown) {
      calls.push({ name: 'getRows', args });
      return {
        edges: [
          {
            cursor: 'cursor-1',
            node: {
              id: 'row-1',
              data: { title: 'Run' },
              readonly: false,
              createdAt: new Date('2026-07-07T00:00:00.000Z'),
              updatedAt: '2026-07-07T00:00:01.000Z',
            },
          },
          { cursor: 'cursor-2' },
        ],
      };
    },
    async getRow(args: unknown) {
      calls.push({ name: 'getRow', args });
      return { id: 'row-1', data: { title: 'Run' } };
    },
    async createRow(args: { rowId: string; data: object }) {
      calls.push({ name: 'createRow', args });
      return { row: { id: args.rowId, data: args.data } };
    },
    async updateRow(args: { rowId: string; data: object }) {
      calls.push({ name: 'updateRow', args });
      return { row: { id: args.rowId, data: args.data } };
    },
    async patchRow(args: { rowId: string; patches: object[] }) {
      calls.push({ name: 'patchRow', args });
      return { row: { id: args.rowId, data: { patches: args.patches } } };
    },
    async createRevision(args: unknown) {
      calls.push({ name: 'createRevision', args });
      return { id: 'revision-2', sequence: 2 };
    },
    async resolveTableSchema(args: { tableId: string }) {
      calls.push({ name: 'resolveTableSchema', args });
      return { type: 'object', properties: { existing: { type: 'string' } } };
    },
    async createTable(args: unknown) {
      calls.push({ name: 'createTable', args });
      return args;
    },
    async updateTable(args: unknown) {
      calls.push({ name: 'updateTable', args });
      return args;
    },
    ...overrides,
  };
  return engine as typeof engine & EngineApiService;
}

test('ensureControlPlaneProject creates the system project, root branch, seed revisions, and system tables', async () => {
  const prisma = makePrisma(false);

  await ensureControlPlaneProject(prisma as unknown as RevoPrismaService);

  assert.equal(
    prisma.calls.filter((call) => call.name === 'revoProject.upsert').length,
    1,
  );
  assert.equal(
    prisma.calls.filter((call) => call.name === 'tx.branch.create').length,
    1,
  );
  assert.equal(
    prisma.calls.filter((call) => call.name === 'tx.revision.create').length,
    2,
  );
  assert.equal(
    prisma.calls.filter((call) => call.name === 'tx.table.create').length,
    3,
  );
});

test('ensureControlPlaneProject is idempotent when the branch already exists', async () => {
  const prisma = makePrisma(true);

  await ensureControlPlaneProject(prisma as unknown as RevoPrismaService);

  assert.equal(
    prisma.calls.filter((call) => call.name === '$transaction').length,
    0,
  );
});

test('ensureControlPlaneProject tolerates a concurrent root branch insert', async () => {
  const prisma = makePrisma({
    branchCreateError: branchUniqueConstraintError(),
    branchExistsAfterBranchCreateError: true,
  });

  await ensureControlPlaneProject(prisma as unknown as RevoPrismaService);

  assert.equal(
    prisma.calls.filter((call) => call.name === 'tx.branch.create').length,
    1,
  );
  assert.equal(
    prisma.calls.filter((call) => call.name === 'branch.findUnique').length,
    2,
  );
  assert.equal(
    prisma.calls.filter((call) => call.name === 'tx.revision.create').length,
    0,
  );
});

test('createEngineTransport maps engine CRUD responses to transport rows and filters unsupported ordering', async () => {
  const engine = makeEngine();
  const prisma = makePrisma(true);
  const transport = createEngineTransport(
    'head',
    engine,
    prisma as unknown as RevoPrismaService,
  );

  await transport.assertReady();
  const list = await transport.listRows('roles', {
    first: 10,
    after: 'after-1',
    orderBy: [
      { field: 'createdAt', direction: 'desc' },
      { field: 'data.title', direction: 'asc' } as never,
      { field: 'updatedAt', direction: 'sideways' } as never,
    ],
    where: { id: { equals: 'row-1' } } as never,
  });
  const row = await transport.getRow('roles', 'row-1');
  const created = await transport.createRow('roles', 'row-2', {
    title: 'Created',
  });
  const updated = await transport.updateRow('roles', 'row-2', {
    title: 'Updated',
  });
  const patched = await transport.patchRow('roles', 'row-2', [
    { op: 'replace', path: 'title', value: 'Patched' },
  ]);

  assert.deepEqual(list.edges, [
    {
      cursor: 'cursor-1',
      node: {
        id: 'row-1',
        data: { title: 'Run' },
        readonly: false,
        createdAt: '2026-07-07T00:00:00.000Z',
        updatedAt: '2026-07-07T00:00:01.000Z',
      },
    },
  ]);
  assert.deepEqual(row.data, { title: 'Run' });
  assert.deepEqual(created.data, { title: 'Created' });
  assert.deepEqual(updated.data, { title: 'Updated' });
  assert.deepEqual(patched.data, {
    patches: [{ op: 'replace', path: 'title', value: 'Patched' }],
  });
  assert.deepEqual(
    (
      engine.calls.find((call) => call.name === 'getRows')?.args as {
        orderBy?: unknown;
      }
    ).orderBy,
    [{ createdAt: 'desc' }],
  );
});

test('draft engine transport invalidates a stale draft scope once and retries with the fresh revision', async () => {
  let attempts = 0;
  const engine = makeEngine({
    async getRows() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('revision is not a draft');
        (error as { status?: number }).status = 400;
        throw error;
      }
      return { edges: [{ node: { id: 'row-1', data: { ok: true } } }] };
    },
    async getDraftRevision() {
      return { id: attempts === 0 ? 'stale-draft' : 'fresh-draft' };
    },
  });
  const prisma = makePrisma(true);
  const transport = createEngineTransport(
    'draft',
    engine,
    prisma as unknown as RevoPrismaService,
  );

  const rows = await transport.listRows('roles');

  assert.equal(attempts, 2);
  assert.equal(rows.edges?.at(0)?.node?.id, 'row-1');
});

test('engine transport maps engine failures to control-plane errors', async () => {
  const engine = makeEngine({
    async createRow() {
      const error = new Error('Rows already exist: row-1');
      (error as { status?: number }).status = 400;
      throw error;
    },
    async updateRow() {
      const error = new Error('invalid row');
      (error as { status?: number }).status = 422;
      throw error;
    },
  });
  const prisma = makePrisma(true);
  const transport = createEngineTransport(
    'head',
    engine,
    prisma as unknown as RevoPrismaService,
  );

  await assert.rejects(
    () => transport.createRow('roles', 'row-1', {}),
    (error) =>
      error instanceof ControlPlaneError && error.code === 'ROW_CONFLICT',
  );
  await assert.rejects(
    () => transport.updateRow('roles', 'row-1', {}),
    (error) =>
      error instanceof ControlPlaneError && error.code === 'VALIDATION_FAILURE',
  );
});

test('assertReady reports missing control-plane meaning tables as a bootstrap failure', async () => {
  const engine = makeEngine({
    async getTables() {
      return { edges: [{ node: { id: controlPlaneMeaningTables[0] } }] };
    },
  });
  const prisma = makePrisma(true);
  const transport = createEngineTransport(
    'head',
    engine,
    prisma as unknown as RevoPrismaService,
  );

  await assert.rejects(
    () => transport.assertReady(),
    (error) =>
      error instanceof ControlPlaneError &&
      error.code === 'BOOTSTRAP_NOT_APPLIED',
  );
});

test('assertReady paginates engine tables before reporting bootstrap readiness', async () => {
  const calls: Array<{ after?: string }> = [];
  const engine = makeEngine({
    async getTables(args: { after?: string }) {
      calls.push(args);
      if (calls.length === 1) {
        return {
          edges: [{ cursor: 'cursor-1', node: { id: controlPlaneMeaningTables[0] } }],
          pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
        };
      }
      return {
        edges: controlPlaneMeaningTables.slice(1).map((id) => ({ node: { id } })),
        pageInfo: { hasNextPage: false },
      };
    },
  });
  const prisma = makePrisma(true);
  const transport = createEngineTransport(
    'head',
    engine,
    prisma as unknown as RevoPrismaService,
  );

  await transport.assertReady();

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.after, 'cursor-1');
});

test('createEngineVersionedMeaningScope delegates writes and commits a new engine revision', async () => {
  const engine = makeEngine();
  const prisma = makePrisma(true);
  const scope = createEngineVersionedMeaningScope(
    engine,
    prisma as unknown as RevoPrismaService,
  );

  const rows = await scope.listRows('roles', {
    first: 10,
    after: 'cursor-0',
    where: { data: { path: 'playbook_id', equals: 'pb' } },
  });
  await scope.getRow('roles', 'row-1');
  await scope.createRow('roles', 'row-2', { title: 'Created' });
  await scope.updateRow('roles', 'row-2', { title: 'Updated' });
  const revision = await scope.commit('seed');

  assert.deepEqual(rows, [{ id: 'row-1', data: { title: 'Run' }, cursor: 'cursor-1' }]);
  assert.deepEqual(
    engine.calls.find((call) => call.name === 'getRows')?.args,
    {
      revisionId: 'draft-1',
      tableId: 'roles',
      first: 10,
      after: 'cursor-0',
      orderBy: undefined,
      where: { data: { path: 'playbook_id', equals: 'pb' } },
    },
  );
  assert.deepEqual(revision, { id: 'revision-2', sequence: 2 });
  assert.equal(
    engine.calls.filter((call) => call.name === 'createRevision').length,
    1,
  );
});

test('applyEngineBootstrapTables creates missing tables and applies additive schema patches', async () => {
  const engine = makeEngine({
    async resolveTableSchema(args: { tableId: string }) {
      if (args.tableId === 'missing') {
        const error = new Error(
          `Table "${args.tableId}" does not exist in the revision`,
        );
        (error as { status?: number }).status = 400;
        throw error;
      }
      if (args.tableId === 'current')
        return { type: 'object', properties: { kept: { type: 'string' } } };
      return { type: 'object', properties: { field: { type: 'string' } } };
    },
  });
  const prisma = makePrisma(true);

  const changes = await applyEngineBootstrapTables(
    engine,
    prisma as unknown as RevoPrismaService,
    [
      {
        id: 'missing',
        schema: { type: 'object', properties: { created: { type: 'string' } } },
      },
      {
        id: 'current',
        schema: {
          type: 'object',
          properties: { kept: { type: 'string' }, added: { type: 'number' } },
        },
      },
      {
        id: 'unchanged',
        schema: { type: 'object', properties: { field: { type: 'string' } } },
      },
    ],
  );

  assert.equal(changes, 2);
  assert.equal(
    engine.calls.filter((call) => call.name === 'createTable').length,
    1,
  );
  assert.equal(
    engine.calls.filter((call) => call.name === 'updateTable').length,
    1,
  );
});

test('applyEngineBootstrapTables does not create a table when schema resolution fails for non-not-found errors', async () => {
  const engine = makeEngine({
    async resolveTableSchema() {
      throw new Error('database unavailable');
    },
  });
  const prisma = makePrisma(true);

  await assert.rejects(
    () =>
      applyEngineBootstrapTables(
        engine,
        prisma as unknown as RevoPrismaService,
        [
          {
            id: 'broken',
            schema: {
              type: 'object',
              properties: { field: { type: 'string' } },
            },
          },
        ],
      ),
    /database unavailable/,
  );
  assert.equal(
    engine.calls.filter((call) => call.name === 'createTable').length,
    0,
  );
});
