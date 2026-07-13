import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../../pipeline-core/index.js';
import type { Template } from '../../pipeline-core/types.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type Pipeline = {
  id: string;
  execution_policy?: { template_json?: Template };
};

function pipelines(path: string): Pipeline[] {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as Pipeline[];
}

test('M0: the shipped catalog contains valid default pipeline templates and seeded profiles', () => {
  const catalog = pipelines('control-plane/default-playbook/catalog/pipelines.json');
  for (const pipelineId of ['feature-development', 'local-change', 'analysis-only']) {
    const template = catalog.find((pipeline) => pipeline.id === pipelineId)?.execution_policy?.template_json;
    assert.ok(template, `${pipelineId} carries a template`);
    assert.equal(template.specVersion, '1.0');
    assert.deepEqual(validateTemplate(template).filter((diagnostic) => diagnostic.severity === 'error'), []);
  }

  const profiles = JSON.parse(
    readFileSync(resolve(repositoryRoot, 'control-plane/default-playbook/catalog/run-profiles.json'), 'utf8'),
  ) as Array<{ id: string; pipelineId: string; status: string }>;
  assert.deepEqual(
    profiles
      .filter((profile) => profile.pipelineId === 'feature-development' && profile.status === 'active')
      .map((profile) => profile.id)
      .sort(),
    [
      'claude-opus-4-8-codex-gpt-5-6-luna-consensus',
      'claude-opus-4-8-sonnet-4-6',
      'codex-gpt-5-6-luna',
      'codex-gpt-5-6-luna-claude-opus-4-8-consensus',
    ],
  );
});

test('M0b: the shipped default catalog is distinct from the E2E fixture catalog', () => {
  const shipped = pipelines('control-plane/default-playbook/catalog/pipelines.json');
  const fixture = pipelines('src/e2e/support/fixtures/playbook/catalog/pipelines.json');

  assert.ok(shipped.some((pipeline) => pipeline.id === 'feature-development'));
  assert.ok(fixture.some((pipeline) => pipeline.id === 'feature-development'));
  assert.notDeepEqual(shipped, fixture);
});
