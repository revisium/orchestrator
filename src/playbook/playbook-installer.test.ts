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
      schema_version: 1,
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
        default_model_level: 'standard',
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

function fakeAccess() {
  const rows: VersionedMeaningRow[] = [];
  const operations: VersionedMeaningOperation[] = [];
  let commitMessage = '';
  const access: VersionedMeaningAccess = {
    async upsertRow(row) {
      rows.push(row);
      const op: VersionedMeaningOperation = { action: 'dry-run', table: row.table, rowId: row.rowId };
      operations.push(op);
      return op;
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

test('PlaybookInstaller: dry-run never calls the versioned writer', async () => {
  const root = makePlaybookRoot();
  let writes = 0;
  const installer = new PlaybookInstaller({
    access: {
      async upsertRow() {
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
