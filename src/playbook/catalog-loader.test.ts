import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPlaybookCatalogs } from './catalog-loader.js';
import { PlaybookError } from './errors.js';
import type { PlaybookManifest } from './manifest.js';

function makeRoot(): { root: string; manifest: PlaybookManifest } {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-catalog-'));
  mkdirSync(join(root, 'catalog'));
  mkdirSync(join(root, 'roles', 'developer'), { recursive: true });
  mkdirSync(join(root, 'pipelines', 'feature-development'), { recursive: true });
  writeFileSync(join(root, 'roles', 'developer', 'ROLE.md'), '# Developer\n');
  writeFileSync(join(root, 'pipelines', 'feature-development', 'PIPELINE.md'), '# Pipeline\n');
  const manifest: PlaybookManifest = {
    id: 'pb',
    name: 'PB',
    schemaVersion: 2,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supportedRuntimes: ['revo'],
  };
  return { root, manifest };
}

test('loadPlaybookCatalogs: validates role and pipeline records', () => {
  const { root, manifest } = makeRoot();
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: 'roles/developer/ROLE.md',
        surface: 'any',
        rights: 'write-working-tree',
        default_model_level: 'standard',
        runner_id: 'claude-code',
        wrappers: {},
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
        execution_policy: {},
      },
    ]),
  );

  const catalogs = loadPlaybookCatalogs(root, manifest);

  assert.equal(catalogs.roles[0]?.id, 'developer');
  assert.equal(catalogs.roles[0]?.runnerId, 'claude-code');
  assert.equal(catalogs.pipelines[0]?.id, 'feature-development');
});

test('loadPlaybookCatalogs: rejects path traversal', () => {
  const { root, manifest } = makeRoot();
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: '../outside.md',
        surface: 'any',
        rights: 'write-working-tree',
        default_model_level: 'standard',
        runner_id: 'claude-code',
      },
    ]),
  );
  writeFileSync(join(root, 'catalog', 'pipelines.json'), JSON.stringify([]));

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    (err: unknown) => err instanceof PlaybookError && err.code === 'PLAYBOOK_INVALID_PATH',
  );
});

test('loadPlaybookCatalogs: rejects pipelines that reference unknown roles', () => {
  const { root, manifest } = makeRoot();
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: 'roles/developer/ROLE.md',
        surface: 'any',
        rights: 'write-working-tree',
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
        required_roles: ['reviewer'],
        alternative_roles: [],
        optional_roles: [],
        route_gates: ['merge approval'],
        platform_invocation: 'canonical-only',
      },
    ]),
  );

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /references unknown role id: reviewer/,
  );
});

test('loadPlaybookCatalogs: rejects stub-agent as a production role runner', () => {
  const { root, manifest } = makeRoot();
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: 'roles/developer/ROLE.md',
        surface: 'any',
        rights: 'write-working-tree',
        default_model_level: 'standard',
        runner_id: 'stub-agent',
      },
    ]),
  );
  writeFileSync(join(root, 'catalog', 'pipelines.json'), JSON.stringify([]));

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /execution profile override/,
  );
});

test('loadPlaybookCatalogs: normalizes runner_id before production-runner validation', () => {
  const { root, manifest } = makeRoot();
  writeFileSync(
    join(root, 'catalog', 'roles.json'),
    JSON.stringify([
      {
        id: 'developer',
        path: 'roles/developer/ROLE.md',
        surface: 'any',
        rights: 'write-working-tree',
        default_model_level: 'standard',
        runner_id: ' stub-agent ',
      },
    ]),
  );
  writeFileSync(join(root, 'catalog', 'pipelines.json'), JSON.stringify([]));

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /runner_id must not be stub-agent/,
  );
});
