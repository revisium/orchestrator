import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';
import { validateTemplate } from '../pipeline-core/index.js';
import type { ConsumesRef, Node, Template } from '../pipeline-core/types.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy?: {
    template_json?: Template;
  };
};

type EffectNode = Extract<Node, { kind: 'agent' | 'script' }>;

const e2eFixtureCatalog = readCatalog(join(repoRoot, 'src/e2e/fixtures/playbook/catalog/pipelines.json'));
const defaultCatalog = readCatalog(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'));

function readCatalog(path: string): PipelineCatalogEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as PipelineCatalogEntry[];
}

function templateFrom(catalog: PipelineCatalogEntry[], pipelineId: string): Template {
  const template = catalog.find((pipeline) => pipeline.id === pipelineId)?.execution_policy?.template_json;
  assert.ok(template, `${pipelineId} carries execution_policy.template_json`);
  return template;
}

function effectNode(template: Template, nodeId: string): EffectNode {
  const node = template.nodes[nodeId];
  if (!node || (node.kind !== 'agent' && node.kind !== 'script')) {
    assert.fail(`${template.pipelineId}.${nodeId} must be an agent or script node`);
  }
  return node;
}

function assertNoValidationErrors(template: Template): void {
  const errors = validateTemplate(template).filter((diagnostic) => diagnostic.severity === 'error');
  assert.deepEqual(errors, [], `${template.pipelineId} template must have no validation errors`);
}

for (const pipeline of e2eFixtureCatalog) {
  test(`e2e fixture: ${pipeline.id} template validates via validateTemplate (zero errors)`, () => {
    const template = pipeline.execution_policy?.template_json;
    assert.ok(template, `${pipeline.id} carries execution_policy.template_json`);
    assertNoValidationErrors(template);
  });
}

test('e2e fixture: feature-development-dd preserves produced-change dataflow from the default feature pipeline', () => {
  const defaultFeature = templateFrom(defaultCatalog, 'feature-development');
  const fixtureFeatureDd = templateFrom(e2eFixtureCatalog, 'feature-development-dd');
  assertNoValidationErrors(fixtureFeatureDd);

  assert.deepEqual(
    effectNode(fixtureFeatureDd, 'developer').produces,
    effectNode(defaultFeature, 'developer').produces,
  );
  assert.deepEqual(
    effectNode(fixtureFeatureDd, 'reworkDeveloper').produces,
    effectNode(defaultFeature, 'reworkDeveloper').produces,
  );
  assert.deepEqual(
    effectNode(fixtureFeatureDd, 'codeReview').consumes,
    effectNode(defaultFeature, 'codeReview').consumes,
  );

  const defaultDeveloperChangeInputs = effectNode(defaultFeature, 'integrator').consumes?.filter((input) =>
    input.node === 'developer' || input.node === 'reworkDeveloper' || input.node === 'stuckReworkDeveloper',
  ) satisfies ConsumesRef[] | undefined;
  assert.deepEqual(effectNode(fixtureFeatureDd, 'integrator').consumes, defaultDeveloperChangeInputs);
});

test('e2e fixture: feature-development review rework already hands its produced change to reviewIntegrator', () => {
  const fixtureFeature = templateFrom(e2eFixtureCatalog, 'feature-development');
  assert.deepEqual(effectNode(fixtureFeature, 'reviewRework').produces, { name: 'change' });
  assert.deepEqual(effectNode(fixtureFeature, 'reviewIntegrator').consumes, [
    {
      node: 'reviewRework',
      as: 'reviewChange',
    },
  ]);
});
