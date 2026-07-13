import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybookError } from './errors.js';
import { assertValidInlineRunProfile, assertValidRunProfileCatalogRecord } from './catalog-schema-validator.js';
import { mapPlaybookRows } from './import-mapper.js';
import type { PlaybookCatalogs } from './catalog-loader.js';
import type { PlaybookManifest } from './manifest.js';

const exactProfile = {
  schemaVersion: 'run-profile/v1',
  topology: { stages: { developer: { mode: 'single' } } },
  bindings: {
    slots: {
      'role:developer': {
        runnerId: 'codex',
        provider: 'openai',
        modelId: 'gpt-exact',
        modelParams: {},
      },
    },
  },
};

test('catalog and inline profile entry points accept the same exact binding shape', () => {
  assert.doesNotThrow(() => assertValidInlineRunProfile(exactProfile, 'profile'));
  assert.doesNotThrow(() => assertValidRunProfileCatalogRecord({
    id: 'exact',
    pipelineId: 'local-change',
    schemaVersion: 'run-profile/v1',
    version: '1',
    displayName: 'Exact',
    summary: 'Exact profile',
    topology: exactProfile.topology,
    bindings: exactProfile.bindings,
    status: 'active',
  }, 'runProfiles[0]'));
});

test('catalog profile validation exposes stable structural and semantic codes', () => {
  assert.throws(
    () => assertValidInlineRunProfile({
      ...exactProfile,
      bindings: { slots: { 'role:developer': { ...exactProfile.bindings.slots['role:developer'], modelLevel: 'deep' } } },
    }, 'profile'),
    (error: unknown) => error instanceof PlaybookError && (error.details as { code?: string })?.code === 'profile_schema_invalid',
  );

  assert.throws(
    () => assertValidInlineRunProfile({
      ...exactProfile,
      bindings: { slots: { 'node:developer': { accounts: { github: 'bot' }, modelId: 'gpt' } } },
    }, 'profile'),
    (error: unknown) => error instanceof PlaybookError && (error.details as { code?: string })?.code === 'profile_script_binding_invalid',
  );
});

test('playbook import maps only role meaning and provider-neutral pipeline fields', () => {
  const manifest: PlaybookManifest = {
    id: 'exact-playbook',
    name: 'Exact playbook',
    schemaVersion: 2,
    packageName: '@revisium/exact-playbook',
    catalogs: { roles: 'roles.json', pipelines: 'pipelines.json', runProfiles: 'run-profiles.json' },
    supportedRuntimes: ['revo'],
  };
  const catalogs: PlaybookCatalogs = {
    roles: [{
      id: 'developer',
      path: 'AGENTS.md',
      surface: 'repo',
      rights: 'workspace-write',
      allowedTools: ['Read'],
      wrappers: {},
    }],
    pipelines: [{
      id: 'local-change',
      path: 'AGENTS.md',
      triggers: ['local change'],
      routeGates: [],
      platformInvocation: 'canonical-only',
      executionPolicy: {},
    }],
    runProfiles: [{
      id: 'exact',
      pipelineId: 'local-change',
      schemaVersion: 'run-profile/v1',
      version: '1',
      displayName: 'Exact',
      summary: 'Exact profile',
      topology: exactProfile.topology,
      bindings: exactProfile.bindings,
      status: 'active',
    }],
  };
  const rows = mapPlaybookRows({
    root: process.cwd(),
    source: { type: 'local', input: '.', root: process.cwd(), source: 'local:.', packageName: manifest.packageName, version: '1' },
    manifest,
    catalogs,
  });
  assert.equal('model_level' in rows.roles[0]!.data, false);
  assert.equal('runner_id' in rows.roles[0]!.data, false);
  assert.equal('required_roles' in rows.pipelines[0]!.data, false);
  assert.equal('optional_roles' in rows.pipelines[0]!.data, false);
});
