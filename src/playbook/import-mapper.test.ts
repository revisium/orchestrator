import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapPlaybookRows, scopedImportRowId } from './import-mapper.js';
import type { PlaybookManifest } from './manifest.js';
import type { PlaybookCatalogs } from './catalog-loader.js';

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
        allowedTools: ['Read', 'Grep', 'Glob'],
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
  // A playbook role's id IS its runtime id (identity passthrough — no name-translation table in code).
  assert.match(String(rows.roles[0]?.data.scope_rules), /"runtime_role_id":"watcher"/);
  assert.deepEqual(rows.roles[0]?.data.allowed_tools, ['Read', 'Grep', 'Glob']);
  assert.equal(rows.pipelines[0]?.rowId, 'pb-feature-development');
  assert.deepEqual(rows.pipelines[0]?.data.route_gates, []);
  assert.equal(rows.catalogHash.length, 64);
});

test('mapPlaybookRows: passes allowedTools through verbatim from the catalog', () => {
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
          allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
          defaultModelLevel: 'standard',
          runnerId: 'claude-code',
          wrappers: {},
        },
      ],
      pipelines: [],
    },
    now: '2026-06-13T00:00:00.000Z',
  });

  assert.deepEqual(rows.roles[0]?.data.allowed_tools, ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob']);
  // no `kind` field is ever persisted (the role-kind machinery was removed in slice 4).
  assert.equal('kind' in (rows.roles[0]?.data ?? {}), false);
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
          allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
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
          allowedTools: ['Read', 'Bash'],
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

test('mapPlaybookRows: mutating a role prompt changes catalogHash (prompt hashes are folded in)', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-prompt-hash-'));
  mkdirSync(join(root, 'roles', 'watcher'), { recursive: true });
  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher v1\n');
  const manifest: PlaybookManifest = {
    id: 'pb', name: 'PB', schemaVersion: 2, packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };
  const catalogs: PlaybookCatalogs = {
    roles: [{
      id: 'watcher', path: 'roles/watcher/ROLE.md', surface: 'repo', rights: 'read-only',
      allowedTools: ['Read'], defaultModelLevel: 'cheap', runnerId: 'claude-code', wrappers: {},
    }],
    pipelines: [],
  };
  const source = { type: 'local' as const, input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' };

  const hash1 = mapPlaybookRows({ root, source, manifest, catalogs, now: '2026-01-01T00:00:00.000Z' }).catalogHash;
  assert.equal(hash1.length, 64);

  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher v2 — updated prompt body\n');

  const hash2 = mapPlaybookRows({ root, source, manifest, catalogs, now: '2026-01-01T00:00:00.000Z' }).catalogHash;
  assert.equal(hash2.length, 64);
  assert.notEqual(hash1, hash2, 'a prompt body change must be reflected in catalogHash');
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
            allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
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
