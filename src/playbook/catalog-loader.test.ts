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
  return {
    root,
    manifest: {
      id: 'pb',
      name: 'PB',
      schemaVersion: 2,
      packageName: '@x/pb',
      catalogs: {
        roles: 'catalog/roles.json',
        pipelines: 'catalog/pipelines.json',
        runProfiles: 'catalog/run-profiles.json',
      },
      supportedRuntimes: ['revo'],
    },
  };
}

function writeCatalogs(root: string, overrides: { role?: Record<string, unknown>; pipeline?: Record<string, unknown>; profile?: Record<string, unknown> } = {}): void {
  writeFileSync(join(root, 'catalog', 'roles.json'), JSON.stringify([{
    id: 'developer',
    path: 'roles/developer/ROLE.md',
    surface: 'any',
    rights: 'write-working-tree',
    allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
    wrappers: {},
    ...overrides.role,
  }]));
  writeFileSync(join(root, 'catalog', 'pipelines.json'), JSON.stringify([{
    id: 'feature-development',
    path: 'pipelines/feature-development/PIPELINE.md',
    triggers: ['new feature'],
    route_gates: ['merge approval'],
    platform_invocation: 'canonical-only',
    execution_policy: {},
    ...overrides.pipeline,
  }]));
  writeFileSync(join(root, 'catalog', 'run-profiles.json'), JSON.stringify([{
    id: 'exact-codex',
    pipelineId: 'feature-development',
    schemaVersion: 'run-profile/v1',
    version: '1',
    displayName: 'Exact Codex',
    summary: 'Direct exact binding fixture.',
    topology: { stages: { developer: { mode: 'single' } } },
    bindings: {
      slots: {
        'role:developer': {
          runnerId: 'codex',
          provider: 'openai',
          modelId: 'gpt-5.6-luna',
          modelParams: {},
        },
      },
    },
    status: 'active',
    ...overrides.profile,
  }]));
}

test('loadPlaybookCatalogs accepts provider-neutral catalogs and exact run profiles', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root);

  const catalogs = loadPlaybookCatalogs(root, manifest);

  assert.deepEqual(catalogs.roles[0], {
    id: 'developer',
    path: 'roles/developer/ROLE.md',
    surface: 'any',
    rights: 'write-working-tree',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash'],
    wrappers: {},
  });
  assert.deepEqual(catalogs.pipelines[0], {
    id: 'feature-development',
    path: 'pipelines/feature-development/PIPELINE.md',
    triggers: ['new feature'],
    routeGates: ['merge approval'],
    platformInvocation: 'canonical-only',
    executionPolicy: {},
  });
  assert.equal(catalogs.runProfiles[0]?.bindings && typeof catalogs.runProfiles[0]?.bindings, 'object');
  assert.equal(catalogs.runProfiles[0]?.status, 'active');
});

test('loadPlaybookCatalogs rejects runner and model authority in role catalogs', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root, { role: { runner_id: 'codex' } });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    (error: unknown) => error instanceof PlaybookError && /runner_id is not part/.test(error.message),
  );
});

test('loadPlaybookCatalogs rejects launch authority in pipeline catalogs', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root, { pipeline: { required_roles: ['developer'] } });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    (error: unknown) => error instanceof PlaybookError && /required_roles is not part/.test(error.message),
  );
});

test('loadPlaybookCatalogs rejects path traversal before import', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root, { role: { path: '../outside.md' } });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    (error: unknown) => error instanceof PlaybookError && error.code === 'PLAYBOOK_INVALID_PATH',
  );
});

test('loadPlaybookCatalogs rejects invalid exact profile bodies', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root, { profile: { bindings: { slots: { 'role:developer': { runnerId: 'codex', modelLevel: 'standard' } } } } });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    (error: unknown) => error instanceof PlaybookError && /run-profile\/v1|unknown field/.test(error.message),
  );
});

test('loadPlaybookCatalogs rejects a profile that references an unknown pipeline', () => {
  const { root, manifest } = makeRoot();
  writeCatalogs(root, { profile: { pipelineId: 'missing-pipeline' } });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /references unknown pipeline id: missing-pipeline/,
  );
});
