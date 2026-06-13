import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapPlaybookRows, runtimeRoleName, scopedImportRowId } from './import-mapper.js';
import type { PlaybookManifest } from './manifest.js';
import type { PlaybookCatalogs } from './catalog-loader.js';

test('runtimeRoleName: maps watcher to current pr-watcher runtime name', () => {
  assert.equal(runtimeRoleName('watcher'), 'pr-watcher');
  assert.equal(runtimeRoleName('developer-backend'), 'developer-backend');
});

test('scopedImportRowId: returns Revisium-safe scoped row ids', () => {
  assert.equal(scopedImportRowId('pb', 'developer-backend'), 'pb-developer-backend');

  const rowId = scopedImportRowId('pb/name', 'developer/backend');
  assert.match(rowId, /^pb-name-developer-backend-[a-f0-9]{12}$/);
  assert.match(rowId, /^[A-Za-z0-9_-]+$/);

  assert.notEqual(scopedImportRowId('pb', 'developer/backend'), scopedImportRowId('pb', 'developer-backend'));

  const longRowId = scopedImportRowId(
    'very-long-playbook-name-that-keeps-going',
    'very-long-role-name-that-keeps-going',
  );
  assert.ok(longRowId.length <= 64);
  assert.match(longRowId, /^[A-Za-z0-9_-]+$/);
  assert.match(longRowId, /-[a-f0-9]{12}$/);
});

test('mapPlaybookRows: maps roles and pipelines into versioned rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-map-'));
  mkdirSync(join(root, 'roles', 'watcher', 'references'), { recursive: true });
  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher\n');
  writeFileSync(join(root, 'roles', 'watcher', 'references', 'core.md'), '# Watch Core\n');
  const manifest: PlaybookManifest = {
    id: 'pb',
    name: 'PB',
    schemaVersion: 1,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };
  const catalogs: PlaybookCatalogs = {
    roles: [
      {
        id: 'watcher',
        path: 'roles/watcher/ROLE.md',
        surface: 'repo',
        rights: 'read-only',
        defaultModelLevel: 'cheap',
        wrappers: {},
      },
    ],
    pipelines: [
      {
        id: 'feature-development',
        path: 'pipelines/feature-development/PIPELINE.md',
        triggers: ['new feature'],
        requiredRoles: ['watcher'],
        alternativeRoles: [],
        optionalRoles: [],
        routeGates: [],
        platformInvocation: 'canonical-only',
        executionPolicy: { iteration_cap: 3 },
      },
    ],
  };

  const rows = mapPlaybookRows({
    root,
    source: { type: 'local', input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' },
    manifest,
    catalogs,
    now: '2026-06-13T00:00:00.000Z',
  });

  assert.equal(rows.playbook.rowId, 'pb');
  assert.equal(rows.roles[0]?.rowId, 'pb-watcher');
  assert.equal(rows.roles[0]?.data.name, 'watcher');
  assert.equal(rows.roles[0]?.data.runner, 'claude-code');
  assert.match(String(rows.roles[0]?.data.scope_rules), /"runtime_role_id":"pr-watcher"/);
  assert.equal(rows.pipelines[0]?.rowId, 'pb-feature-development');
  assert.equal(rows.catalogHash.length, 64);
});
