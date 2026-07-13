import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mapPlaybookRows, scopedImportRowId, scopedRunProfileRowId } from './import-mapper.js';
import type { PlaybookManifest } from './manifest.js';
import type { PlaybookCatalogs } from './catalog-loader.js';

function source(root: string) {
  return { type: 'local' as const, input: '.', root, source: `local:${root}`, packageName: '@x/pb', version: '1.0.0' };
}

function manifest(): PlaybookManifest {
  return {
    id: 'pb',
    name: 'PB',
    schemaVersion: 2,
    packageName: '@x/pb',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json', runProfiles: 'catalog/run-profiles.json' },
    supportedRuntimes: ['revo'],
  };
}

function catalogs(): PlaybookCatalogs {
  return {
    roles: [{
      id: 'watcher',
      path: 'roles/watcher/ROLE.md',
      surface: 'repo',
      rights: 'read-only',
      allowedTools: ['Read', 'Grep', 'Glob'],
      wrappers: {},
    }],
    pipelines: [{
      id: 'feature-development',
      path: 'pipelines/feature-development/PIPELINE.md',
      triggers: ['new feature'],
      routeGates: ['merge approval'],
      platformInvocation: 'canonical-only',
      executionPolicy: { iteration_cap: 3 },
    }],
    runProfiles: [{
      id: 'exact-codex',
      pipelineId: 'feature-development',
      schemaVersion: 'run-profile/v1',
      version: '1',
      displayName: 'Exact Codex',
      summary: 'Direct exact model binding.',
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
    }],
  };
}

test('scopedImportRowId and scopedRunProfileRowId keep ids deterministic and bounded', () => {
  assert.equal(scopedImportRowId('pb', 'developer-backend'), 'pb-developer-backend');
  assert.equal(scopedRunProfileRowId('pb', 'feature-development', 'exact-codex'), 'pb-19-feature-development-exact-codex');
  assert.notEqual(scopedRunProfileRowId('pb', 'feature-development', 'exact-codex'), scopedRunProfileRowId('pb', 'analysis-only', 'exact-codex'));
  const long = scopedImportRowId('very-long-playbook-name-that-keeps-going', 'very-long-role-name-that-keeps-going');
  assert.ok(long.length <= 64);
  assert.match(long, /^[A-Za-z0-9_-]+$/);
});

test('mapPlaybookRows imports provider-neutral roles and exact profile JSON', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-map-'));
  mkdirSync(join(root, 'roles', 'watcher', 'references'), { recursive: true });
  mkdirSync(join(root, 'pipelines', 'feature-development'), { recursive: true });
  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher\n');
  writeFileSync(join(root, 'roles', 'watcher', 'references', 'core.md'), '# Watch Core\n');
  writeFileSync(join(root, 'pipelines', 'feature-development', 'PIPELINE.md'), '# Feature\n');

  const rows = mapPlaybookRows({ root, source: source(root), manifest: manifest(), catalogs: catalogs(), now: '2026-06-13T00:00:00.000Z' });

  assert.equal(rows.playbook.rowId, 'pb');
  assert.equal(rows.roles[0]?.rowId, 'pb-watcher');
  assert.equal(rows.roles[0]?.data.name, 'watcher');
  assert.equal('runner_id' in (rows.roles[0]?.data ?? {}), false);
  assert.deepEqual(rows.pipelines[0]?.data.route_gates, ['merge']);
  assert.equal(rows.runProfiles[0]?.table, 'run_profiles');
  assert.equal(rows.runProfiles[0]?.data.profile_id, 'exact-codex');
  assert.equal(rows.runProfiles[0]?.data.pipeline_id, 'feature-development');
  const stored = JSON.parse(String(rows.runProfiles[0]?.data.profile_json)) as Record<string, unknown>;
  assert.equal(stored.pipelineId, undefined);
  assert.equal(stored.id, undefined);
  assert.deepEqual((stored.bindings as { slots: Record<string, unknown> }).slots['role:developer'], {
    runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {},
  });
  assert.equal(rows.catalogHash.length, 64);
});

test('mapPlaybookRows folds role prompt bodies into the catalog hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-playbook-prompt-hash-'));
  mkdirSync(join(root, 'roles', 'watcher'), { recursive: true });
  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher v1\n');
  const first = mapPlaybookRows({ root, source: source(root), manifest: manifest(), catalogs: catalogs(), now: '2026-01-01T00:00:00.000Z' }).catalogHash;
  writeFileSync(join(root, 'roles', 'watcher', 'ROLE.md'), '# Watcher v2\n');
  const second = mapPlaybookRows({ root, source: source(root), manifest: manifest(), catalogs: catalogs(), now: '2026-01-01T00:00:00.000Z' }).catalogHash;
  assert.notEqual(first, second);
});
