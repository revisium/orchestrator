import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlaybookInstaller } from './playbook-installer.js';
import type { VersionedMeaningAccess, VersionedMeaningOperation, VersionedMeaningRow } from '../control-plane/versioned-meaning.js';

function makePlaybookRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-install-'));
  mkdirSync(join(root, 'catalog'));
  mkdirSync(join(root, 'roles', 'developer', 'references'), { recursive: true });
  mkdirSync(join(root, 'pipelines', 'feature-development'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@x/pb', version: '1.0.0' }));
  writeFileSync(
    join(root, 'playbook.json'),
    JSON.stringify({
      id: 'pb',
      name: 'PB',
      schema_version: 2,
      package: '@x/pb',
      catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
      supported_runtimes: ['revo'],
    }),
  );
  writeFileSync(join(root, 'roles', 'developer', 'ROLE.md'), '# Developer\n');
  writeFileSync(join(root, 'roles', 'developer', 'references', 'core.md'), '# Core\n');
  writeFileSync(join(root, 'pipelines', 'feature-development', 'PIPELINE.md'), '# Feature\n');
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: 'roles/developer/ROLE.md',
        surface: 'any',
        rights: 'write-working-tree',
        allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
        default_model_level: 'standard',
        runner_id: 'claude-code',
      },
    ]),
  );
  writeFileSync(
    join(root, 'catalog', 'pipelines.json'),
    JSON.stringify([
      {
        id: 'feature-development',
        path: 'pipelines/feature-development/PIPELINE.md',
        triggers: ['new feature'],
        required_roles: ['developer'],
        alternative_roles: [],
        optional_roles: [],
        route_gates: ['merge approval'],
        platform_invocation: 'canonical-only',
        execution_policy: { iteration_cap: 3 },
      },
    ]),
  );
  return root;
}

function fakeAccess(existing: VersionedMeaningRow[] = []) {
  const rows: VersionedMeaningRow[] = [];
  const operations: VersionedMeaningOperation[] = [];
  const existingRows = new Map(existing.map((row) => [`${row.table}/${row.rowId}`, row]));
  let commitMessage = '';
  const access: VersionedMeaningAccess = {
    async upsertRow(row) {
      rows.push(row);
      const key = `${row.table}/${row.rowId}`;
      const existing = existingRows.get(key);
      const action = row.table === 'run_profiles' &&
        existing &&
        existing.data.profile_hash !== existing.data.source_hash
        ? 'preserve'
        : 'dry-run';
      if (action !== 'preserve') existingRows.set(key, row);
      const op: VersionedMeaningOperation = { action, table: row.table, rowId: row.rowId };
      operations.push(op);
      return op;
    },
    async retireMissingRows({ table, playbookId, keepRowIds, retiredAt }) {
      const keep = new Set(keepRowIds);
      const retired: VersionedMeaningOperation[] = [];
      for (const row of existingRows.values()) {
        if (row.table !== table) continue;
        if (row.data.playbook_id !== playbookId) continue;
        if (keep.has(row.rowId)) continue;
        row.data.status = 'removed';
        row.data.retired_at = retiredAt;
        const op: VersionedMeaningOperation = { action: 'retire', table, rowId: row.rowId };
        operations.push(op);
        retired.push(op);
      }
      return retired;
    },
    async commit(message) {
      commitMessage = message;
      return { id: 'rev-1' };
    },
  };
  return { access, rows, operations, get commitMessage() { return commitMessage; } };
}

test('PlaybookInstaller: validates, maps, and writes playbook rows', async () => {
  const root = makePlaybookRoot();
  const fake = fakeAccess();
  const installer = new PlaybookInstaller({
    access: fake.access,
    sourceResolverOptions: { cwd: join(root, '..') },
  });

  const result = await installer.install({ source: `./${basename(root)}`, commit: true });

  assert.equal(result.playbookId, 'pb');
  assert.equal(result.roles, 1);
  assert.equal(result.pipelines, 1);
  assert.equal(result.committed, true);
  assert.equal(result.revisionId, 'rev-1');
  assert.equal(
    fake.rows.map((row) => `${row.table}/${row.rowId}`).join(','),
    'playbooks/pb,roles/pb-developer,pipelines/pb-feature-development',
  );
  assert.equal(fake.commitMessage, 'Install playbook PB@1.0.0');
});

test('PlaybookInstaller: preserves edited run profiles during catalog re-import', async () => {
  const root = makePlaybookRoot();
  writeFileSync(
    join(root, 'playbook.json'),
    JSON.stringify({
      id: 'pb',
      name: 'PB',
      schema_version: 2,
      package: '@x/pb',
      catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json', runProfiles: 'catalog/run-profiles.json' },
      supported_runtimes: ['revo'],
    }),
  );
  writeFileSync(
    join(root, 'catalog', 'run-profiles.json'),
    JSON.stringify([
      {
        id: 'codex-standard',
        pipelineId: 'feature-development',
        schemaVersion: 'run-profile/v1',
        version: '1',
        displayName: 'Codex standard',
        summary: 'Codex standard profile',
        topology: { stages: { planReviewer: { mode: 'single' } } },
        bindings: { slots: { developer: { runnerId: 'codex', modelLevel: 'codex-standard' } } },
        status: 'active',
      },
    ]),
  );
  const fake = fakeAccess([
    {
      table: 'run_profiles',
      rowId: 'pb-feature-development-codex-standard',
      data: {
        id: 'pb-feature-development-codex-standard',
        playbook_id: 'pb',
        pipeline_id: 'feature-development',
        profile_id: 'codex-standard',
        profile_hash: 'user-edited-hash',
        source_hash: 'catalog-hash',
        status: 'active',
      },
    },
  ]);
  const installer = new PlaybookInstaller({
    access: fake.access,
    sourceResolverOptions: { cwd: join(root, '..') },
  });

  const result = await installer.install({ source: `./${basename(root)}`, commit: true });

  assert.ok(result.operations.some((op) =>
    op.action === 'preserve' &&
    op.table === 'run_profiles' &&
    op.rowId === 'pb-feature-development-codex-standard',
  ));
});

test('PlaybookInstaller: dry-run never calls the versioned writer', async () => {
  const root = makePlaybookRoot();
  let writes = 0;
  const installer = new PlaybookInstaller({
    access: {
      async upsertRow() {
        writes += 1;
        throw new Error('dry-run should not write');
      },
      async retireMissingRows() {
        writes += 1;
        throw new Error('dry-run should not write');
      },
      async commit() {
        throw new Error('dry-run should not commit');
      },
    },
    sourceResolverOptions: { cwd: join(root, '..') },
  });

  const result = await installer.install({ source: `./${basename(root)}`, dryRun: true, commit: true });

  assert.equal(writes, 0);
  assert.equal(result.dryRun, true);
  assert.equal(result.committed, false);
  assert.equal(result.operations.every((op) => op.action === 'dry-run'), true);
});

test('PlaybookInstaller: retires rows removed from the playbook catalog', async () => {
  const root = makePlaybookRoot();
  const fake = fakeAccess([
    {
      table: 'pipelines',
      rowId: 'pb-removed-pipeline',
      data: {
        id: 'pb-removed-pipeline',
        playbook_id: 'pb',
        status: 'active',
      },
    },
    {
      table: 'run_profiles',
      rowId: 'pb-removed-profile',
      data: {
        id: 'pb-removed-profile',
        playbook_id: 'pb',
        status: 'active',
      },
    },
  ]);
  const installer = new PlaybookInstaller({
    access: fake.access,
    sourceResolverOptions: { cwd: join(root, '..') },
  });

  const result = await installer.install({ source: `./${basename(root)}`, commit: true });

  assert.deepEqual(
    result.operations.filter((op) => op.action === 'retire').map((op) => `${op.table}/${op.rowId}`).sort(),
    [
      'pipelines/pb-removed-pipeline',
      'run_profiles/pb-removed-profile',
    ],
  );
});
