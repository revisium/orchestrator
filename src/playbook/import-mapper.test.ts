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
    schemaVersion: 2,
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
        runnerId: 'claude-code',
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
  assert.equal(rows.roles[0]?.data.runner_id, 'claude-code');
  assert.match(String(rows.roles[0]?.data.scope_rules), /"runtime_role_id":"pr-watcher"/);
  assert.equal(rows.pipelines[0]?.rowId, 'pb-feature-development');
  assert.deepEqual(rows.pipelines[0]?.data.route_gates, []);
  assert.equal(rows.catalogHash.length, 64);
});

test('mapPlaybookRows: normalizes canonical gate labels to workflow gate ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-map-'));
  mkdirSync(join(root, 'roles', 'developer'), { recursive: true });
  mkdirSync(join(root, 'pipelines', 'feature-development'), { recursive: true });
  writeFileSync(join(root, 'roles', 'developer', 'ROLE.md'), '# Developer\n');
  writeFileSync(join(root, 'pipelines', 'feature-development', 'PIPELINE.md'), '# Feature\n');
  const manifest: PlaybookManifest = {
    id: 'pb',
    name: 'PB',
    schemaVersion: 2,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };

  const rows = mapPlaybookRows({
    root,
    source: { type: 'local', input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' },
    manifest,
    catalogs: {
      roles: [
        {
          id: 'developer',
          path: 'roles/developer/ROLE.md',
          surface: 'any',
          rights: 'write-working-tree',
          defaultModelLevel: 'standard',
          runnerId: 'claude-code',
          wrappers: {},
        },
      ],
      pipelines: [
        {
          id: 'feature-development',
          path: 'pipelines/feature-development/PIPELINE.md',
          triggers: ['new feature'],
          requiredRoles: ['developer'],
          alternativeRoles: [],
          optionalRoles: [],
          routeGates: ['task spec approval', 'merge approval', 'merge'],
          platformInvocation: 'canonical-only',
          executionPolicy: {},
        },
      ],
    },
    now: '2026-06-13T00:00:00.000Z',
  });

  assert.deepEqual(rows.pipelines[0]?.data.route_gates, ['plan', 'merge']);
});

test('mapPlaybookRows: runner_id, not rights, selects the runtime runner', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-map-'));
  mkdirSync(join(root, 'roles', 'integrator'), { recursive: true });
  writeFileSync(join(root, 'roles', 'integrator', 'ROLE.md'), '# Integrator\n');
  const manifest: PlaybookManifest = {
    id: 'pb',
    name: 'PB',
    schemaVersion: 2,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };
  const rows = mapPlaybookRows({
    root,
    source: { type: 'local', input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' },
    manifest,
    catalogs: {
      roles: [
        {
          id: 'integrator',
          path: 'roles/integrator/ROLE.md',
          surface: 'repo',
          rights: 'git-gh',
          defaultModelLevel: 'standard',
          runnerId: 'revo-integrator',
          wrappers: {},
        },
      ],
      pipelines: [],
    },
    now: '2026-06-13T00:00:00.000Z',
  });

  assert.equal(rows.roles[0]?.data.runner, 'revo-integrator');
  assert.equal(rows.roles[0]?.data.runner_id, 'revo-integrator');
});

test('mapPlaybookRows: rejects production stub-agent role bindings', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-map-'));
  mkdirSync(join(root, 'roles', 'developer'), { recursive: true });
  writeFileSync(join(root, 'roles', 'developer', 'ROLE.md'), '# Developer\n');
  const manifest: PlaybookManifest = {
    id: 'pb',
    name: 'PB',
    schemaVersion: 2,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };

  assert.throws(
    () => mapPlaybookRows({
      root,
      source: { type: 'local', input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' },
      manifest,
      catalogs: {
        roles: [
          {
            id: 'developer',
            path: 'roles/developer/ROLE.md',
            surface: 'any',
            rights: 'write-working-tree',
            defaultModelLevel: 'standard',
            runnerId: 'stub-agent',
            wrappers: {},
          },
        ],
        pipelines: [],
      },
      now: '2026-06-13T00:00:00.000Z',
    }),
    /stub-agent/,
  );
});
