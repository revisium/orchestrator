import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../config.js';
import { validateTemplate } from '../../pipeline-core/index.js';
import type { ConsumesRef, Node, Template } from '../../pipeline-core/types.js';

type PipelineCatalogEntry = {
  id: string;
  required_roles?: string[];
  execution_policy?: {
    template_json?: Template;
  };
};

type EffectNode = Extract<Node, { kind: 'agent' | 'script' }>;

const e2eFixtureCatalog = readCatalog(join(repoRoot, 'src/e2e/support/fixtures/playbook/catalog/pipelines.json'));
const defaultCatalog = readCatalog(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'));

function readCatalog(path: string): PipelineCatalogEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as PipelineCatalogEntry[];
}

function templateFrom(catalog: PipelineCatalogEntry[], pipelineId: string): Template {
  const template = catalog.find((pipeline) => pipeline.id === pipelineId)?.execution_policy?.template_json;
  assert.ok(template, `${pipelineId} carries execution_policy.template_json`);
  return template;
}

function pipelineFrom(catalog: PipelineCatalogEntry[], pipelineId: string): PipelineCatalogEntry {
  const pipeline = catalog.find((candidate) => candidate.id === pipelineId);
  assert.ok(pipeline, `${pipelineId} exists in the catalog`);
  return pipeline;
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

test('L0: the data-driven fixture carries a complete state-machine template and capability roles', () => {
  const pipeline = pipelineFrom(e2eFixtureCatalog, 'feature-development-dd');
  const template = templateFrom(e2eFixtureCatalog, pipeline.id);

  assert.equal(template.specVersion, '1.0');
  assert.ok(template.nodes['analyst']);
  for (const roleId of ['analyst', 'developer', 'reviewer', 'watcher', 'integrator']) {
    assert.ok(pipeline.required_roles?.includes(roleId), `${roleId} is declared by the fixture pipeline`);
  }
});

for (const [caseId, pipelineId, roleId] of [
  ['K3', 'feature-pr-watch', 'pr-watcher'],
  ['K5', 'feature-pr-poll', 'pr-poller'],
] as const) {
  test(`${caseId}: the post-integrator role is bound by template placement`, () => {
    const pipeline = pipelineFrom(e2eFixtureCatalog, pipelineId);
    const template = templateFrom(e2eFixtureCatalog, pipelineId);
    const integrator = effectNode(template, 'integrator');
    const postIntegrator = effectNode(template, 'watcherPost');

    assert.equal(integrator.next, 'watcherPost');
    assert.equal(postIntegrator.kind, 'agent');
    assert.equal('roleRef' in postIntegrator ? postIntegrator.roleRef : undefined, `role:${roleId}`);
    const roles = pipeline.required_roles ?? [];
    assert.ok(roles.indexOf(roleId) > roles.indexOf('integrator'));
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
  assert.deepEqual(effectNode(fixtureFeature, 'questionReviewRework').consumes, [
    {
      node: 'triage',
      as: 'triage',
    },
    {
      node: 'questionGate',
      as: 'gateResolution',
    },
  ]);
  assert.deepEqual(effectNode(fixtureFeature, 'questionReviewIntegrator').consumes, [
    {
      node: 'questionReviewRework',
      as: 'reviewChange',
    },
  ]);
});

test('e2e fixture (#246): feature-development has mergeApproveReverify + classifyRecovery + recoveryGate', () => {
  const feature = templateFrom(e2eFixtureCatalog, 'feature-development');

  // mergeApproveReverify: script node that re-polls readiness after approval before confirmMerge
  const reverify = effectNode(feature, 'mergeApproveReverify');
  assert.equal(reverify.kind, 'script', 'mergeApproveReverify is a script node');
  assert.equal(reverify.next, 'mergeApproveReverifyRouter', 'mergeApproveReverify feeds the reverify router');

  // classifyRecovery: agent node that increments the recoveryLoop counter
  const classify = effectNode(feature, 'classifyRecovery');
  assert.equal(classify.kind, 'agent', 'classifyRecovery is an agent node');
  assert.ok(
    classify.incrementCounters?.includes('recoveryLoop'),
    'classifyRecovery increments recoveryLoop',
  );

  // recoveryGate: humanGate node that opens when the recoveryLoop is exhausted or scripts fail
  const gate = feature.nodes['recoveryGate'];
  assert.ok(gate, 'recoveryGate node exists');
  assert.equal(gate?.kind, 'humanGate', 'recoveryGate is a humanGate');

  // confirmMerge consumes the fresh mergeApproveReverify evidence (not stale pre-gate readiness)
  const confirm = effectNode(feature, 'confirmMerge');
  const freshnessConsume = confirm.consumes?.find((c) => c.node === 'mergeApproveReverify');
  assert.ok(freshnessConsume, 'confirmMerge consumes mergeApproveReverify evidence');
  assert.equal(freshnessConsume?.as, 'mergeReadiness', 'consumeRef alias is mergeReadiness');
});
