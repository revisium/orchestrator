import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createVersionedMeaningAccess,
  type VersionedMeaningListOptions,
  type VersionedMeaningScope,
} from './versioned-meaning.js';
import type { RowWhereInput } from './query-types.js';

function valueAtPath(data: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, data ?? {});
}

function matchesWhere(rowId: string, data: Record<string, unknown>, where: RowWhereInput | undefined): boolean {
  if (!where) return true;
  if (where.id?.equals !== undefined && rowId !== where.id.equals) return false;
  if (where.id?.in !== undefined && !where.id.in.includes(rowId)) return false;
  if (where.data?.path !== undefined && where.data.equals !== undefined && valueAtPath(data, where.data.path) !== where.data.equals) return false;
  if (where.data?.path !== undefined && where.data.in !== undefined && !where.data.in.includes(valueAtPath(data, where.data.path))) return false;
  if (where.AND?.some((item) => !matchesWhere(rowId, data, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(rowId, data, item))) return false;
  const not = where.NOT;
  if (Array.isArray(not) && not.some((item) => matchesWhere(rowId, data, item))) return false;
  if (not && !Array.isArray(not) && matchesWhere(rowId, data, not)) return false;
  return true;
}

function fakeScope(seed: Record<string, Record<string, unknown>> = {}) {
  const rows = new Map(Object.entries(seed));
  const calls: string[] = [];
  const scope: VersionedMeaningScope = {
    async listRows(table, options?: VersionedMeaningListOptions) {
      calls.push(`list:${table}`);
      const selected = [...rows.entries()].flatMap(([key, data]) => {
        const [rowTable, rowId] = key.split('/');
        return rowTable === table && rowId && matchesWhere(rowId, data, options?.where)
          ? [{ id: rowId, data, cursor: rowId }]
          : [];
      });
      const afterIndex = options?.after ? selected.findIndex((row) => row.cursor === options.after || row.id === options.after) : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      return selected.slice(start, start + (options?.first ?? selected.length));
    },
    async getRow(table, rowId) {
      calls.push(`get:${table}/${rowId}`);
      const row = rows.get(`${table}/${rowId}`);
      if (!row) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return { id: rowId, data: row };
    },
    async createRow(table, rowId, data) {
      calls.push(`create:${table}/${rowId}`);
      rows.set(`${table}/${rowId}`, data as Record<string, unknown>);
      return { id: rowId, data };
    },
    async updateRow(table, rowId, data) {
      calls.push(`update:${table}/${rowId}`);
      rows.set(`${table}/${rowId}`, data as Record<string, unknown>);
      return { id: rowId, data };
    },
    async commit(comment) {
      calls.push(`commit:${comment}`);
      return { id: 'rev-1' };
    },
  };
  return { scope, calls, rows };
}

test('createVersionedMeaningAccess: dry-run does not create a scope or write rows', async () => {
  let called = false;
  const access = createVersionedMeaningAccess({
    dryRun: true,
    scopeFactory: async () => {
      called = true;
      return fakeScope().scope;
    },
  });

  const op = await access.upsertRow({ table: 'playbooks', rowId: 'pb', data: { id: 'pb' } });
  const revision = await access.commit('commit');

  assert.equal(op.action, 'dry-run');
  assert.equal(revision, null);
  assert.equal(called, false);
});

test('createVersionedMeaningAccess: creates missing rows and updates existing rows', async () => {
  const fake = fakeScope({ 'roles/developer': { id: 'developer', name: 'old' } });
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const created = await access.upsertRow({ table: 'playbooks', rowId: 'pb', data: { id: 'pb' } });
  const updated = await access.upsertRow({ table: 'roles', rowId: 'developer', data: { id: 'developer', name: 'new' } });
  await access.commit('Install playbook');

  assert.equal(created.action, 'create');
  assert.equal(updated.action, 'update');
  assert.deepEqual(fake.calls, [
    'get:playbooks/pb',
    'create:playbooks/pb',
    'get:roles/developer',
    'update:roles/developer',
    'commit:Install playbook',
  ]);
});

test('createVersionedMeaningAccess: preserves edited catalog run profiles during import', async () => {
  const fake = fakeScope({
    'run_profiles/pb-feature-development-codex-standard': {
      id: 'pb-feature-development-codex-standard',
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      profile_id: 'codex-standard',
      profile_hash: 'user-edited-hash',
      source_hash: 'catalog-hash',
      status: 'active',
    },
  });
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const op = await access.upsertRow({
    table: 'run_profiles',
    rowId: 'pb-feature-development-codex-standard',
    data: {
      id: 'pb-feature-development-codex-standard',
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      profile_id: 'codex-standard',
      profile_hash: 'new-catalog-hash',
      source_hash: 'new-catalog-hash',
      status: 'active',
    },
  });

  assert.deepEqual(op, { action: 'preserve', table: 'run_profiles', rowId: 'pb-feature-development-codex-standard' });
  assert.equal(fake.rows.get('run_profiles/pb-feature-development-codex-standard')?.profile_hash, 'user-edited-hash');
  assert.equal(fake.calls.includes('update:run_profiles/pb-feature-development-codex-standard'), false);
});

test('createVersionedMeaningAccess: retires catalog rows removed from the playbook import', async () => {
  const fake = fakeScope({
    'pipelines/pb-feature-development': { id: 'pb-feature-development', playbook_id: 'pb', status: 'active' },
    'pipelines/pb-removed-pipeline': {
      id: 'pb-removed-pipeline',
      playbook_id: 'pb',
      status: 'active',
    },
    'pipelines/other-feature-development': { id: 'other-feature-development', playbook_id: 'other', status: 'active' },
  });
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const retired = await access.retireMissingRows({
    table: 'pipelines',
    playbookId: 'pb',
    keepRowIds: ['pb-feature-development'],
    retiredAt: '2026-07-07T00:00:00.000Z',
  });

  assert.deepEqual(retired, [{
    action: 'retire',
    table: 'pipelines',
    rowId: 'pb-removed-pipeline',
  }]);
  assert.deepEqual(fake.rows.get('pipelines/pb-removed-pipeline'), {
    id: 'pb-removed-pipeline',
    playbook_id: 'pb',
    status: 'removed',
    retired_at: '2026-07-07T00:00:00.000Z',
    updated_at: '2026-07-07T00:00:00.000Z',
  });
  assert.equal(fake.rows.get('pipelines/other-feature-development')?.status, 'active');
});

test('createVersionedMeaningAccess: retireMissingRows preserves user-managed and edited run profiles', async () => {
  const fake = fakeScope({
    'run_profiles/pb-catalog-clean': {
      id: 'pb-catalog-clean',
      playbook_id: 'pb',
      profile_hash: 'catalog-hash',
      source_hash: 'catalog-hash',
      status: 'active',
    },
    'run_profiles/pb-catalog-edited': {
      id: 'pb-catalog-edited',
      playbook_id: 'pb',
      profile_hash: 'user-hash',
      source_hash: 'catalog-hash',
      status: 'active',
    },
    'run_profiles/pb-user-created': {
      id: 'pb-user-created',
      playbook_id: 'pb',
      profile_hash: 'user-hash',
      source_hash: '',
      status: 'active',
    },
  });
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const retired = await access.retireMissingRows({
    table: 'run_profiles',
    playbookId: 'pb',
    keepRowIds: [],
    retiredAt: '2026-07-07T00:00:00.000Z',
  });

  assert.deepEqual(retired, [{ action: 'retire', table: 'run_profiles', rowId: 'pb-catalog-clean' }]);
  assert.equal(fake.rows.get('run_profiles/pb-catalog-clean')?.status, 'removed');
  assert.equal(fake.rows.get('run_profiles/pb-catalog-edited')?.status, 'active');
  assert.equal(fake.rows.get('run_profiles/pb-user-created')?.status, 'active');
});

test('createVersionedMeaningAccess: retireMissingRows paginates scoped catalog rows', async () => {
  const seed: Record<string, Record<string, unknown>> = {};
  const keepRowIds: string[] = [];
  for (let i = 0; i < 501; i += 1) {
    const rowId = `pb-role-${String(i).padStart(3, '0')}`;
    seed[`roles/${rowId}`] = { id: rowId, playbook_id: 'pb', status: 'active' };
    if (i < 500) keepRowIds.push(rowId);
  }
  seed['roles/other-role'] = { id: 'other-role', playbook_id: 'other', status: 'active' };
  const fake = fakeScope(seed);
  const access = createVersionedMeaningAccess({ scopeFactory: async () => fake.scope });

  const retired = await access.retireMissingRows({
    table: 'roles',
    playbookId: 'pb',
    keepRowIds,
    retiredAt: '2026-07-07T00:00:00.000Z',
  });

  assert.deepEqual(retired, [{ action: 'retire', table: 'roles', rowId: 'pb-role-500' }]);
  assert.equal(fake.calls.filter((call) => call === 'list:roles').length, 2);
  assert.equal(fake.rows.get('roles/other-role')?.status, 'active');
});
