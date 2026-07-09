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

function writeValidRoleCatalog(root: string): void {
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
        wrappers: {},
      },
    ]),
  );
}

function writeValidPipelineCatalog(root: string, executionPolicy: unknown = {}): void {
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
        execution_policy: executionPolicy,
      },
    ]),
  );
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
        allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
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
  assert.deepEqual(catalogs.roles[0]?.allowedTools, ['Read', 'Edit', 'Write', 'Bash']);
  assert.equal(catalogs.pipelines[0]?.id, 'feature-development');
});

test('loadPlaybookCatalogs: rejects a role missing allowed_tools', () => {
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
  writeFileSync(join(root, 'catalog', 'pipelines.json'), JSON.stringify([]));

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /allowed_tools must be a string array/,
  );
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
    /run profile binding/,
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

test('loadPlaybookCatalogs: rejects invalid pipeline template_json before import', () => {
  const { root, manifest } = makeRoot();
  writeValidRoleCatalog(root);
  writeValidPipelineCatalog(root, {
    template_json: {
      specVersion: '1.0',
      pipelineId: 'feature-development',
      entry: 'developer',
      verdicts: { domain: ['approved'] },
    },
  });

  assert.throws(
    () => loadPlaybookCatalogs(root, manifest),
    /pipelines\[0\]\.execution_policy violates pipeline execution_policy schema: .*\/template_json\/nodes/,
  );
});

test('loadPlaybookCatalogs: rejects invalid run profile JSON before import', () => {
  const { root, manifest } = makeRoot();
  const manifestWithProfiles: PlaybookManifest = {
    ...manifest,
    catalogs: { ...manifest.catalogs, runProfiles: 'catalog/run-profiles.json' },
  };
  writeValidRoleCatalog(root);
  writeValidPipelineCatalog(root);
  writeFileSync(
    join(root, 'catalog', 'run-profiles.json'),
    JSON.stringify([
      {
        id: 'codex-consensus',
        pipelineId: 'feature-development',
        schemaVersion: 'run-profile/v1',
        version: '1',
        displayName: 'Codex consensus',
        summary: 'Invalid consensus profile missing branch count.',
        topology: { stages: { codeReview: { mode: 'consensus' } } },
        bindings: { slots: { developer: { runnerId: 'codex', modelLevel: 'codex-standard' } } },
        status: 'active',
      },
    ]),
  );

  assert.throws(
    () => loadPlaybookCatalogs(root, manifestWithProfiles),
    /runProfiles\[0\] violates run-profile\/v1 schema: .*\/topology\/stages\/codeReview\/branches/,
  );
});

test('loadPlaybookCatalogs: accepts GitHub account bindings in run profiles', () => {
  const { root, manifest } = makeRoot();
  const manifestWithProfiles: PlaybookManifest = {
    ...manifest,
    catalogs: { ...manifest.catalogs, runProfiles: 'catalog/run-profiles.json' },
  };
  writeValidRoleCatalog(root);
  writeValidPipelineCatalog(root);
  writeFileSync(
    join(root, 'catalog', 'run-profiles.json'),
    JSON.stringify([
      {
        id: 'codex-standard',
        pipelineId: 'feature-development',
        schemaVersion: 'run-profile/v1',
        version: '1',
        displayName: 'Codex standard',
        summary: 'Profile pins the GitHub account for its script slot.',
        topology: { stages: { codeReview: { mode: 'single' } } },
        bindings: {
          slots: {
            developer: { runnerId: 'codex', modelLevel: 'codex-standard' },
            integrator: { accounts: { github: 'profile-bot' } },
          },
        },
        status: 'active',
      },
    ]),
  );

  const catalogs = loadPlaybookCatalogs(root, manifestWithProfiles);
  assert.equal(catalogs.runProfiles[0]?.id, 'codex-standard');
  const bindings = catalogs.runProfiles[0]?.bindings as { slots: Record<string, unknown> } | undefined;
  assert.deepEqual(bindings?.slots.integrator, { accounts: { github: 'profile-bot' } });
});

test('loadPlaybookCatalogs: rejects top-level publishing fields in run profiles', () => {
  const { root, manifest } = makeRoot();
  const manifestWithProfiles: PlaybookManifest = {
    ...manifest,
    catalogs: { ...manifest.catalogs, runProfiles: 'catalog/run-profiles.json' },
  };
  writeValidRoleCatalog(root);
  writeValidPipelineCatalog(root);
  writeFileSync(
    join(root, 'catalog', 'run-profiles.json'),
    JSON.stringify([
      {
        id: 'codex-standard',
        pipelineId: 'feature-development',
        schemaVersion: 'run-profile/v1',
        version: '1',
        displayName: 'Codex standard',
        summary: 'Top-level publishing is not a profile contract.',
        topology: { stages: { codeReview: { mode: 'single' } } },
        bindings: { slots: { developer: { runnerId: 'codex', modelLevel: 'codex-standard' } } },
        publishing: { github: { account: 'profile-bot' } },
        status: 'active',
      },
    ]),
  );

  assert.throws(
    () => loadPlaybookCatalogs(root, manifestWithProfiles),
    /runProfiles\[0\] violates run-profile\/v1 schema: .*additional properties/,
  );
});
