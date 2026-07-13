import test from 'node:test';
import assert from 'node:assert/strict';
import { RevoRepositoryNotFoundError, RevoRepositoryProjectIneligibleError, RevoRepositoryStore } from './revo-repository.store.js';

function prisma() {
  const repository = { id: 'repo_1', projectId: 'project_1', name: 'main', remoteUrl: null, localPath: null, defaultBranch: 'main' };
  const project = { id: 'project_1', name: 'Project', slug: 'project', status: 'ACTIVE', deletedAt: null };
  return {
    repository,
    project,
    revoRepository: {
      async create({ data }: { data: Record<string, unknown> }) { return { ...repository, ...data }; },
      async findUnique({ where, select }: { where: { id: string }; select: Record<string, unknown> }) {
        if (where.id !== repository.id) return null;
        return Object.hasOwn(select, 'project') ? { ...repository, project } : repository;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        if (where.id !== repository.id) throw { code: 'P2025' };
        return { ...repository, ...data };
      },
      async delete({ where }: { where: { id: string } }) {
        if (where.id !== repository.id) throw { code: 'P2025' };
      },
    },
  };
}

test('repository store performs configuration CRUD and launch eligibility checks', async () => {
  const db = prisma();
  const store = new RevoRepositoryStore(db as never);
  assert.equal((await store.create({ projectId: 'project_1', name: 'main' })).name, 'main');
  assert.equal((await store.get('repo_1')).id, 'repo_1');
  assert.equal((await store.update('repo_1', { defaultBranch: 'trunk' })).defaultBranch, 'trunk');
  assert.deepEqual((await store.resolveForLaunch('repo_1')).project.id, 'project_1');
  await store.delete('repo_1');
  await assert.rejects(() => store.get('missing'), RevoRepositoryNotFoundError);
});

test('repository launch rejects archived or soft-deleted projects', async () => {
  const db = prisma();
  db.project.status = 'ARCHIVED';
  const store = new RevoRepositoryStore(db as never);
  await assert.rejects(() => store.resolveForLaunch('repo_1'), RevoRepositoryProjectIneligibleError);
});
