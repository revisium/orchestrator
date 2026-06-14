import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybookManifest } from './manifest.js';
import { PlaybookError } from './errors.js';

test('parsePlaybookManifest: accepts schema version 2 manifest', () => {
  const manifest = parsePlaybookManifest({
    id: 'revisium-agent-playbook',
    name: 'Revisium Agent Playbook',
    schema_version: 2,
    package: '@revisium/agent-playbook',
    catalogs: { roles: 'catalog/roles.json', pipelines: 'catalog/pipelines.json' },
    supported_runtimes: ['codex', 'claude-code', 'revo'],
  });

  assert.equal(manifest.id, 'revisium-agent-playbook');
  assert.equal(manifest.catalogs.roles, 'catalog/roles.json');
});

test('parsePlaybookManifest: rejects unsupported schema version before import', () => {
  assert.throws(
    () =>
      parsePlaybookManifest({
        id: 'x',
        name: 'X',
        schema_version: 99,
        package: 'x',
        catalogs: { roles: 'roles.json', pipelines: 'pipelines.json' },
      }),
    (err: unknown) => err instanceof PlaybookError && err.code === 'PLAYBOOK_UNSUPPORTED_SCHEMA',
  );
});
