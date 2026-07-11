import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../../config.js';
import type { Template } from '../../pipeline-core/types.js';
import type {
  MaterializedCoverageIdentity,
  PipelineCaseAttachment,
  PipelineCoverageRegistry,
  PipelineCoverageTag,
} from './pipeline-coverage.js';
import { nonDslPipelineCaseAttachment } from './non-dsl-ownership.js';
import {
  PIPELINE_COVERAGE_MANIFEST,
  PIPELINE_COVERAGE_REGISTRY,
  coverageForScenario,
  definePipelineCoverageRegistry,
  derivePipelineCoverageCatalog,
  graphCoverageTagsForTemplate,
  pipelineCoverageCellId,
  routingSignatureForRunProfile,
  validatePipelineCaseAttachment,
  validatePipelineCoverageRegistry,
} from './pipeline-coverage.js';

const pipelines = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/pipelines.json'), 'utf8'),
) as Parameters<typeof validatePipelineCoverageRegistry>[0]['pipelines'];
const runProfiles = JSON.parse(
  readFileSync(join(repoRoot, 'control-plane/default-playbook/catalog/run-profiles.json'), 'utf8'),
) as Parameters<typeof validatePipelineCoverageRegistry>[0]['runProfiles'];

function registryWith(patch: Partial<PipelineCoverageRegistry>): PipelineCoverageRegistry {
  return {
    scenarios: patch.scenarios ?? PIPELINE_COVERAGE_REGISTRY.scenarios,
    ownership: patch.ownership ?? PIPELINE_COVERAGE_REGISTRY.ownership,
    waivers: patch.waivers ?? PIPELINE_COVERAGE_REGISTRY.waivers,
  };
}

function assertOwnerSurface(ownerSurface: string): void {
  assert.ok(statSync(join(repoRoot, ownerSurface)).size > 0, `${ownerSurface} must exist and be non-empty`);
}

function materializedIdentity(pipelineId: string, profileId: string): MaterializedCoverageIdentity {
  const identity = PIPELINE_COVERAGE_MANIFEST.catalog.materialized.find((candidate) =>
    candidate.pipelineId === pipelineId && candidate.profileId === profileId);
  assert.ok(identity);
  return identity;
}

function waiverForCell(input: Readonly<{
  id: string;
  tag: PipelineCoverageTag;
  materialized?: MaterializedCoverageIdentity;
  reason: string;
  ownerSurface: string;
  expiry?: Readonly<{ stage?: 'stage-2' | 'stage-3' | 'later'; condition?: string }>;
}>) {
  const materialized = input.materialized ?? materializedIdentity('feature-development', 'base');
  return {
    id: input.id,
    reason: input.reason,
    ownerSurface: input.ownerSurface,
    tags: [input.tag],
    materialized: [materialized],
    cellIds: [pipelineCoverageCellId(materialized, input.tag)],
    ...(input.expiry ? { expiry: input.expiry } : {}),
  };
}

test('pipeline coverage registry: bundled default graph and profile tags are fully owned', () => {
  assert.deepEqual(validatePipelineCoverageRegistry({ pipelines, runProfiles }), []);
});

test('pipeline coverage registry: public scenario mutation cannot forge default ownership', () => {
  const forgedTag = 'node:mergeGate:outcome:forged' as PipelineCoverageTag;
  const forgedPipelines = structuredClone(pipelines);
  const feature = forgedPipelines.find((pipeline) => pipeline.id === 'feature-development');
  const mergeGate = feature?.execution_policy?.template_json?.nodes.mergeGate;
  const scenario = PIPELINE_COVERAGE_MANIFEST.registry.scenarios.find((candidate) =>
    candidate.id === 'M1-profile-single');
  assert.ok(mergeGate && mergeGate.kind === 'humanGate');
  assert.ok(scenario);
  assert.strictEqual(PIPELINE_COVERAGE_MANIFEST.registry, PIPELINE_COVERAGE_REGISTRY);
  (mergeGate.outcomes as string[]).push('forged');

  const beforeMutation = validatePipelineCoverageRegistry({ pipelines: forgedPipelines, runProfiles });
  assert.ok(beforeMutation.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNOWNED_CELL' && diagnostic.tag === forgedTag));

  const ownerSurface = scenario.ownerSurface;
  const tagsLength = scenario.tags.length;
  const primaryTagsLength = scenario.primaryTags.length;
  let mutationResults: boolean[] = [];
  let afterMutation: ReturnType<typeof validatePipelineCoverageRegistry> = [];
  try {
    mutationResults = [
      Reflect.set(scenario, 'ownerSurface', 'src/e2e/pipeline/forged.e2e.test.ts'),
      Reflect.set(scenario.tags, scenario.tags.length, forgedTag),
      Reflect.set(scenario.primaryTags, scenario.primaryTags.length, forgedTag),
    ];
    afterMutation = validatePipelineCoverageRegistry({ pipelines: forgedPipelines, runProfiles });
  } finally {
    Reflect.set(scenario, 'ownerSurface', ownerSurface);
    Reflect.set(scenario.tags, 'length', tagsLength);
    Reflect.set(scenario.primaryTags, 'length', primaryTagsLength);
  }

  assert.deepEqual(mutationResults, [false, false, false]);
  assert.ok(afterMutation.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNOWNED_CELL' && diagnostic.tag === forgedTag));
});

test('pipeline coverage registry: public nested scenario and ownership aliases are immutable', () => {
  const scenario = PIPELINE_COVERAGE_MANIFEST.registry.scenarios.find((candidate) =>
    candidate.id === 'M1-profile-single');
  const ownership = PIPELINE_COVERAGE_MANIFEST.registry.ownership[0];
  assert.ok(scenario);
  assert.ok(ownership);

  const profileId = scenario.materialized.profileId;
  const ownerSurface = ownership.ownerSurface;
  const tagsLength = ownership.tags.length;
  const primaryTagsLength = ownership.primaryTags.length;
  let mutationResults: boolean[] = [];
  try {
    mutationResults = [
      Reflect.set(scenario.materialized, 'profileId', 'forged-profile'),
      Reflect.set(ownership, 'ownerSurface', 'src/e2e/pipeline/forged.e2e.test.ts'),
      Reflect.set(ownership.tags, ownership.tags.length, 'node:mergeGate:outcome:forged'),
      Reflect.set(ownership.primaryTags, ownership.primaryTags.length, 'node:mergeGate:outcome:forged'),
    ];
  } finally {
    Reflect.set(scenario.materialized, 'profileId', profileId);
    Reflect.set(ownership, 'ownerSurface', ownerSurface);
    Reflect.set(ownership.tags, 'length', tagsLength);
    Reflect.set(ownership.primaryTags, 'length', primaryTagsLength);
  }

  assert.deepEqual(mutationResults, [false, false, false, false]);
  assert.equal(Object.isFrozen(scenario.materialized), true);
  assert.equal(Object.isFrozen(ownership), true);
  assert.equal(Object.isFrozen(ownership.tags), true);
  assert.equal(Object.isFrozen(ownership.primaryTags), true);
  assert.equal(Object.isFrozen(ownership.materialized), true);
  assert.ok(ownership.materialized.every((identity) => Object.isFrozen(identity)));
  assert.equal(Object.isFrozen(ownership.cellIds), true);
  assert.equal(Object.isFrozen(ownership.primaryCellIds), true);
});

test('pipeline coverage registry: production builder exactly projects runtime input entries', () => {
  const scenarioMetadata = { value: 'scenario-source' };
  const ownershipMetadata = { value: 'ownership-source' };
  const waiverMetadata = { value: 'waiver-source' };
  const registry = definePipelineCoverageRegistry({
    scenarios: [{
      id: 'runtime-scenario',
      ownerSurface: 'src/e2e/pipeline/runtime-scenario.e2e.test.ts',
      tags: ['node:runtime-scenario:outcome:approved'],
      primaryTags: ['node:runtime-scenario:outcome:approved'],
      materialized: { pipelineId: 'feature-development', profileId: 'base' },
      runtimeMetadata: scenarioMetadata,
    }],
    ownership: [{
      owner: 'unit',
      ownerSurface: 'src/testing/policy/runtime-owner.test.ts',
      tags: ['node:runtime-owner:outcome:approved'],
      primaryTags: ['node:runtime-owner:outcome:approved'],
      materialized: [{ pipelineId: 'feature-development', profileId: 'base' }],
      runtimeMetadata: ownershipMetadata,
    }],
    waivers: [{
      id: 'runtime-waiver',
      reason: 'runtime projection fixture',
      ownerSurface: 'src/testing/policy/pipeline-coverage.test.ts',
      tags: ['node:runtime-waiver:outcome:approved'],
      materialized: [{ pipelineId: 'feature-development', profileId: 'base' }],
      expiry: { stage: 'later' },
      runtimeMetadata: waiverMetadata,
    }],
  } as never);
  const entries = [registry.scenarios[0], registry.ownership[0], registry.waivers[0]];
  const sourceMetadata = [scenarioMetadata, ownershipMetadata, waiverMetadata];

  scenarioMetadata.value = 'scenario-mutated';
  ownershipMetadata.value = 'ownership-mutated';
  waiverMetadata.value = 'waiver-mutated';

  const projectedMetadata = entries.map((entry) => Reflect.get(entry ?? {}, 'runtimeMetadata'));
  assert.deepEqual({
    propertiesPresent: entries.map((entry) => Reflect.has(entry ?? {}, 'runtimeMetadata')),
    aliasesSource: projectedMetadata.map((value, index) => value === sourceMetadata[index]),
    valuesAfterSourceMutation: projectedMetadata.map((value) =>
      (value as { value?: string } | undefined)?.value),
  }, {
    propertiesPresent: [false, false, false],
    aliasesSource: [false, false, false],
    valuesAfterSourceMutation: [undefined, undefined, undefined],
  });
});

test('pipeline coverage registry: production builder deep-freezes detached input graphs', () => {
  const scenarioTag = 'node:scenario:outcome:approved' as PipelineCoverageTag;
  const ownershipTag = 'node:ownership:outcome:approved' as PipelineCoverageTag;
  const waiverTag = 'node:waiver:outcome:approved' as PipelineCoverageTag;
  const forgedTag = 'node:forged:outcome:approved' as PipelineCoverageTag;
  const scenarioTags = [scenarioTag];
  const scenarioPrimaryTags = [scenarioTag];
  const scenarioMaterialized = { pipelineId: 'feature-development', profileId: 'base' };
  const scenario = {
    id: 'input-scenario',
    ownerSurface: 'src/e2e/pipeline/input-scenario.e2e.test.ts',
    tags: scenarioTags,
    primaryTags: scenarioPrimaryTags,
    materialized: scenarioMaterialized,
  };
  const ownershipTags = [ownershipTag];
  const ownershipPrimaryTags = [ownershipTag];
  const ownership = {
    owner: 'static-policy' as const,
    ownerSurface: 'src/testing/policy/input-owner.test.ts',
    tags: ownershipTags,
    primaryTags: ownershipPrimaryTags,
    materialized: [scenarioMaterialized],
    diagnosticCode: 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING' as const,
  };
  const waiverTags = [waiverTag];
  const waiverExpiry = { stage: 'later' as const, condition: 'until replacement coverage lands' };
  const waiver = {
    id: 'input-waiver',
    reason: 'input alias fixture',
    ownerSurface: 'src/testing/policy/pipeline-coverage.test.ts',
    tags: waiverTags,
    materialized: [scenarioMaterialized],
    expiry: waiverExpiry,
  };
  const input = {
    scenarios: [scenario],
    ownership: [ownership],
    waivers: [waiver],
  };

  const registry = definePipelineCoverageRegistry(input);
  const canonicalScenario = registry.scenarios[0];
  const canonicalOwnership = registry.ownership[0];
  const canonicalWaiver = registry.waivers[0];
  assert.ok(canonicalScenario);
  assert.ok(canonicalOwnership);
  assert.ok(canonicalWaiver?.tags);
  assert.ok(canonicalWaiver.expiry);

  for (const value of [
    registry,
    registry.scenarios,
    canonicalScenario,
    canonicalScenario.tags,
    canonicalScenario.primaryTags,
    canonicalScenario.materialized,
    canonicalScenario.cellIds,
    canonicalScenario.primaryCellIds,
    registry.ownership,
    canonicalOwnership,
    canonicalOwnership.tags,
    canonicalOwnership.primaryTags,
    canonicalOwnership.materialized,
    ...canonicalOwnership.materialized,
    canonicalOwnership.cellIds,
    canonicalOwnership.primaryCellIds,
    registry.waivers,
    canonicalWaiver,
    canonicalWaiver.tags,
    canonicalWaiver.materialized,
    ...canonicalWaiver.materialized,
    canonicalWaiver.cellIds,
    canonicalWaiver.expiry,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }

  assert.notStrictEqual(registry.scenarios, input.scenarios);
  assert.notStrictEqual(canonicalScenario, scenario);
  assert.notStrictEqual(canonicalScenario.tags, scenarioTags);
  assert.notStrictEqual(canonicalScenario.primaryTags, scenarioPrimaryTags);
  assert.notStrictEqual(canonicalScenario.materialized, scenarioMaterialized);
  assert.notStrictEqual(registry.ownership, input.ownership);
  assert.notStrictEqual(canonicalOwnership, ownership);
  assert.notStrictEqual(canonicalOwnership.tags, ownershipTags);
  assert.notStrictEqual(canonicalOwnership.primaryTags, ownershipPrimaryTags);
  assert.notStrictEqual(canonicalOwnership.materialized, ownership.materialized);
  assert.notStrictEqual(registry.waivers, input.waivers);
  assert.notStrictEqual(canonicalWaiver, waiver);
  assert.notStrictEqual(canonicalWaiver.tags, waiverTags);
  assert.notStrictEqual(canonicalWaiver.materialized, waiver.materialized);
  assert.notStrictEqual(canonicalWaiver.expiry, waiverExpiry);

  assert.deepEqual([
    Reflect.set(canonicalScenario, 'ownerSurface', 'forged'),
    Reflect.set(canonicalScenario.tags, canonicalScenario.tags.length, forgedTag),
    Reflect.set(canonicalScenario.primaryTags, canonicalScenario.primaryTags.length, forgedTag),
    Reflect.set(canonicalScenario.materialized, 'profileId', 'forged'),
    Reflect.set(canonicalOwnership, 'ownerSurface', 'forged'),
    Reflect.set(canonicalOwnership.tags, canonicalOwnership.tags.length, forgedTag),
    Reflect.set(canonicalOwnership.primaryTags, canonicalOwnership.primaryTags.length, forgedTag),
    Reflect.set(canonicalWaiver, 'ownerSurface', 'forged'),
    Reflect.set(canonicalWaiver.tags, canonicalWaiver.tags.length, forgedTag),
    Reflect.set(canonicalWaiver.expiry, 'stage', 'stage-2'),
  ], Array.from({ length: 10 }, () => false));

  scenario.ownerSurface = 'forged-input-scenario';
  scenarioTags.push(forgedTag);
  scenarioPrimaryTags.push(forgedTag);
  scenarioMaterialized.profileId = 'forged-input-profile';
  ownership.ownerSurface = 'forged-input-owner';
  ownershipTags.push(forgedTag);
  ownershipPrimaryTags.push(forgedTag);
  waiver.ownerSurface = 'forged-input-waiver';
  waiverTags.push(forgedTag);
  waiverExpiry.condition = 'forged input condition';
  input.scenarios.push({ ...scenario, id: 'second-input-scenario' });
  input.ownership.push({ ...ownership, ownerSurface: 'second-input-owner' });
  input.waivers.push({ ...waiver, id: 'second-input-waiver' });

  assert.equal(registry.scenarios.length, 1);
  assert.equal(canonicalScenario.ownerSurface, 'src/e2e/pipeline/input-scenario.e2e.test.ts');
  assert.deepEqual(canonicalScenario.tags, [scenarioTag]);
  assert.deepEqual(canonicalScenario.primaryTags, [scenarioTag]);
  assert.equal(canonicalScenario.materialized.pipelineId, 'feature-development');
  assert.equal(canonicalScenario.materialized.profileId, 'base');
  assert.equal(registry.ownership.length, 1);
  assert.equal(canonicalOwnership.ownerSurface, 'src/testing/policy/input-owner.test.ts');
  assert.deepEqual(canonicalOwnership.tags, [ownershipTag]);
  assert.deepEqual(canonicalOwnership.primaryTags, [ownershipTag]);
  assert.equal(canonicalOwnership.diagnosticCode, 'DEFAULT_POLICY_LOOP_EXHAUSTION_ESCALATION_MISSING');
  assert.equal(registry.waivers.length, 1);
  assert.equal(canonicalWaiver.ownerSurface, 'src/testing/policy/pipeline-coverage.test.ts');
  assert.deepEqual(canonicalWaiver.tags, [waiverTag]);
  assert.deepEqual(canonicalWaiver.expiry, {
    stage: 'later',
    condition: 'until replacement coverage lands',
  });
});

test('pipeline coverage registry: contract identities come from pinned materialized templates and routing signatures', () => {
  const derived = derivePipelineCoverageCatalog(pipelines, runProfiles);
  const single = derived.materialized.find((item) => item.profileId === 'codex-standard');
  const consensus = derived.materialized.find((item) =>
    item.profileId === 'codex-primary-claude-review-consensus');
  assert.ok(single);
  assert.ok(consensus);
  assert.equal(single.routingSignature, 'single-review');
  assert.equal(consensus.routingSignature, 'dual-consensus-review');
  assert.match(single.materializedTemplateHash, /^[a-f0-9]{64}$/);
  assert.match(consensus.materializedTemplateHash, /^[a-f0-9]{64}$/);
  assert.notEqual(single.materializedTemplateHash, consensus.materializedTemplateHash);
  assert.match(derived.catalogIdentity, /^[a-f0-9]{64}$/);

  const singleCell = derived.cells.find((cell) =>
    cell.materialized.profileId === 'codex-standard' &&
    cell.tag === 'node:mergeGate:outcome:approved');
  const consensusCell = derived.cells.find((cell) =>
    cell.materialized.profileId === 'codex-primary-claude-review-consensus' &&
    cell.tag === 'node:mergeGate:outcome:approved');
  assert.ok(singleCell);
  assert.ok(consensusCell);
  assert.notEqual(singleCell.id, consensusCell.id);
  assert.ok(singleCell.id.includes(single.materializedTemplateHash));
  assert.ok(consensusCell.id.includes(consensus.materializedTemplateHash));
});

test('pipeline coverage registry: every DSL scenario has a typed case identity', () => {
  for (const scenario of PIPELINE_COVERAGE_REGISTRY.scenarios) {
    const identity = coverageForScenario(scenario.id as Parameters<typeof coverageForScenario>[0]);
    assert.equal(identity.kind, 'registered-dsl');
    assert.equal(identity.scenarioId, scenario.id);
    assert.equal(identity.ownerSurface, scenario.ownerSurface);
    assert.deepEqual(identity.tags, [...scenario.tags]);
    assert.deepEqual(identity.primaryTags, [...scenario.primaryTags]);
    assert.equal(identity.catalogIdentity, PIPELINE_COVERAGE_MANIFEST.catalog.catalogIdentity);
    assert.equal(identity.materialized.pipelineId, scenario.materialized.pipelineId);
    assert.equal(identity.materialized.profileId, scenario.materialized.profileId);
    assert.equal(Object.isFrozen(identity.materialized), true);
    assert.deepEqual(
      identity.cellIds,
      PIPELINE_COVERAGE_MANIFEST.catalog.cells
        .filter((cell) =>
          cell.materialized.pipelineId === identity.materialized.pipelineId &&
          cell.materialized.profileId === identity.materialized.profileId &&
          cell.materialized.materializedTemplateHash === identity.materialized.materializedTemplateHash &&
          cell.materialized.routingSignature === identity.materialized.routingSignature &&
          scenario.tags.includes(cell.tag))
        .map((cell) => cell.id),
    );
    assert.doesNotThrow(() => validatePipelineCaseAttachment(identity, identity.materialized));
    assertOwnerSurface(identity.ownerSurface);
  }
});

test('pipeline coverage registry: executable attachment rejects a forged registered identity', () => {
  const identity = coverageForScenario('RG-A-merge-approved');
  assert.throws(
    () => validatePipelineCaseAttachment({ ...identity, catalogIdentity: 'stale-catalog' }),
    /registered pipeline attachment does not match the pinned manifest/,
  );
});

test('pipeline coverage registry: public manifest cannot replace an authoritative registered attachment', () => {
  const canonical = coverageForScenario('M1-profile-single');
  const forged = Object.freeze({
    ...canonical,
    ownerSurface: 'src/e2e/pipeline/forged.e2e.test.ts',
    tags: Object.freeze(['node:mergeGate:outcome:cancel' as PipelineCoverageTag]),
    primaryTags: Object.freeze(['node:mergeGate:outcome:cancel' as PipelineCoverageTag]),
  });
  const publicAttachments = PIPELINE_COVERAGE_MANIFEST.attachments as unknown;
  let publicMutationAccepted = false;

  try {
    if (publicAttachments instanceof Map) {
      publicAttachments.set('M1-profile-single', forged);
      publicMutationAccepted = true;
    } else {
      assert.ok(Array.isArray(publicAttachments));
      assert.equal(Object.isFrozen(publicAttachments), true);
      const index = publicAttachments.findIndex((attachment: PipelineCaseAttachment) =>
        attachment.kind === 'registered-dsl' && attachment.scenarioId === 'M1-profile-single');
      assert.notEqual(index, -1);
      assert.equal(Object.isFrozen(publicAttachments[index]), true);
      assert.equal(Object.isFrozen(publicAttachments[index].tags), true);
      assert.equal(Object.isFrozen(publicAttachments[index].primaryTags), true);
      assert.equal(Object.isFrozen(publicAttachments[index].materialized), true);
      assert.equal(Object.isFrozen(publicAttachments[index].cellIds), true);
      assert.equal(Object.isFrozen(publicAttachments[index].primaryCellIds), true);
      publicMutationAccepted = Reflect.set(publicAttachments, index, forged);
    }

    assert.throws(
      () => validatePipelineCaseAttachment(forged, canonical.materialized),
      /registered pipeline attachment does not match the pinned manifest/,
    );
    assert.strictEqual(coverageForScenario('M1-profile-single'), canonical);
    assert.equal(publicMutationAccepted, false);
    assert.doesNotThrow(() => validatePipelineCaseAttachment(canonical, canonical.materialized));
  } finally {
    if (publicAttachments instanceof Map) {
      publicAttachments.set('M1-profile-single', canonical);
    }
  }
});

test('pipeline coverage registry: a registered scenario id cannot pass as an unregistered attachment', () => {
  const attachment = {
    kind: 'non-dsl',
    caseId: 'M1-profile-single',
    ownerLayer: 'pipeline-dsl',
    ownerSurface: 'src/e2e/pipeline/seeded-profiles.e2e.test.ts',
    retainedBehavior: 'forged registered scenario',
  } as unknown as PipelineCaseAttachment;

  assert.throws(
    () => validatePipelineCaseAttachment(attachment),
    /non-DSL pipeline attachment does not match the pinned manifest/,
  );
});

test('pipeline coverage registry: unknown and copied non-DSL attachments are rejected', () => {
  const unknown = {
    kind: 'non-dsl',
    caseId: 'free-string-case',
    ownerLayer: 'pipeline-dsl',
    ownerSurface: 'src/e2e/pipeline/gates.e2e.test.ts',
    retainedBehavior: 'arbitrary free-string identity',
  } as unknown as PipelineCaseAttachment;
  assert.throws(
    () => validatePipelineCaseAttachment(unknown),
    /non-DSL pipeline attachment does not match the pinned manifest/,
  );

  const canonical = nonDslPipelineCaseAttachment('B3');
  assert.throws(
    () => validatePipelineCaseAttachment({ ...canonical }),
    /non-DSL pipeline attachment does not match the pinned manifest/,
  );
});

test('pipeline coverage registry: registered attachments reject the wrong selected materialized identity', () => {
  const attachment = coverageForScenario('M1-profile-single');
  const selected = PIPELINE_COVERAGE_MANIFEST.catalog.materialized.find((identity) =>
    identity.pipelineId === 'feature-development' && identity.profileId === 'codex-standard');
  assert.ok(selected);
  const validateSelected = validatePipelineCaseAttachment as (
    value: PipelineCaseAttachment,
    identity: MaterializedCoverageIdentity,
  ) => void;

  for (const wrong of [
    { ...selected, pipelineId: 'local-change' },
    { ...selected, profileId: 'claude-standard' },
    { ...selected, materializedTemplateHash: '0'.repeat(64) },
    { ...selected, routingSignature: 'wrong-signature' },
  ]) {
    assert.throws(
      () => validateSelected(attachment, wrong),
      /registered pipeline attachment does not match the selected materialized identity/,
    );
  }
});

test('pipeline coverage registry: static, unit, and waiver owner surfaces exist', () => {
  const ownerSurfaces = new Set<string>();
  for (const ownership of PIPELINE_COVERAGE_REGISTRY.ownership) ownerSurfaces.add(ownership.ownerSurface);
  for (const waiver of PIPELINE_COVERAGE_REGISTRY.waivers) ownerSurfaces.add(waiver.ownerSurface);

  for (const ownerSurface of ownerSurfaces) {
    assertOwnerSurface(ownerSurface);
  }
});

test('pipeline coverage registry: rejects undefined DSL tags', () => {
  const materialized = materializedIdentity('feature-development', 'base');
  const tag = 'node:noSuchNode:outcome:approved' as PipelineCoverageTag;
  const cellId = pipelineCoverageCellId(materialized, tag);
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: [{
        id: 'bad-scenario',
        ownerSurface: 'src/e2e/bad.e2e.test.ts',
        tags: [tag],
        primaryTags: [tag],
        materialized,
        cellIds: [cellId],
        primaryCellIds: [cellId],
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNDEFINED_CELL' &&
    diagnostic.scenarioId === 'bad-scenario' &&
    diagnostic.tag === 'node:noSuchNode:outcome:approved',
  ));
});

test('pipeline coverage registry: rejects unowned catalog graph outcomes', () => {
  const unownedTag = 'node:mergeGate:outcome:address_review_threads';
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: PIPELINE_COVERAGE_REGISTRY.scenarios.map((scenario) => ({
        ...scenario,
        tags: scenario.tags.filter((tag) => tag !== unownedTag),
        primaryTags: scenario.primaryTags.filter((tag) => tag !== unownedTag),
        cellIds: scenario.cellIds.filter((cellId) => !String(cellId).endsWith(`::${unownedTag}`)),
        primaryCellIds: scenario.primaryCellIds.filter((cellId) => !String(cellId).endsWith(`::${unownedTag}`)),
      })),
      ownership: PIPELINE_COVERAGE_REGISTRY.ownership.map((owner) => ({
        ...owner,
        tags: owner.tags.filter((tag) => tag !== unownedTag),
        primaryTags: owner.primaryTags.filter((tag) => tag !== unownedTag),
        cellIds: owner.cellIds.filter((cellId) => !String(cellId).endsWith(`::${unownedTag}`)),
        primaryCellIds: owner.primaryCellIds.filter((cellId) => !String(cellId).endsWith(`::${unownedTag}`)),
      })),
      waivers: PIPELINE_COVERAGE_REGISTRY.waivers.map((waiver) => ({
        ...waiver,
        tags: waiver.tags?.filter((tag) => tag !== unownedTag),
        cellIds: waiver.cellIds.filter((cellId) => !String(cellId).endsWith(`::${unownedTag}`)),
      })),
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNOWNED_CELL' &&
    diagnostic.tag === unownedTag,
  ));
});

test('pipeline coverage registry: a cloned template with existing tags has unowned materialized cells', () => {
  const feature = pipelines.find((pipeline) => pipeline.id === 'feature-development');
  assert.ok(feature);
  const clone = structuredClone(feature);
  clone.id = 'feature-development-clone';
  if (clone.execution_policy?.template_json) {
    clone.execution_policy.template_json.pipelineId = clone.id;
  }

  const diagnostics = validatePipelineCoverageRegistry({
    pipelines: [...pipelines, clone],
    runProfiles,
  });

  assert.ok(diagnostics.some((diagnostic) =>
    String(diagnostic.code) === 'PIPELINE_COVERAGE_UNOWNED_CELL' &&
    String(Reflect.get(diagnostic, 'cellId')).includes('feature-development-clone::base::')),
  );
});

test('pipeline coverage registry: DSL ownership does not transfer to a sibling materialization without explicit proof', () => {
  const tag = 'node:mergeGate:outcome:cancel' as PipelineCoverageTag;
  const scenario = PIPELINE_COVERAGE_REGISTRY.scenarios.find((candidate) =>
    candidate.materialized.pipelineId === 'feature-development' &&
    candidate.materialized.profileId === 'base' &&
    candidate.primaryTags.includes(tag));
  const sibling = materializedIdentity('feature-development', 'claude-standard');
  const siblingCellId = pipelineCoverageCellId(sibling, tag);
  assert.ok(scenario);
  assert.deepEqual(
    PIPELINE_COVERAGE_REGISTRY.ownership
      .filter((owner) => owner.primaryCellIds.includes(siblingCellId))
      .map((owner) => owner.diagnosticCode),
    ['DEFAULT_POLICY_MERGE_RECHECK_ROUTE_MISSING'],
  );

  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      ownership: PIPELINE_COVERAGE_REGISTRY.ownership.filter((owner) => owner.diagnosticCode === undefined),
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNOWNED_CELL' && diagnostic.cellId === siblingCellId));
});

test('pipeline coverage registry: rejects incomplete waivers', () => {
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      waivers: [{
        ...waiverForCell({
          id: 'bad-waiver',
          tag: 'node:mergeGate:outcome:cancel',
          reason: '',
          ownerSurface: '',
        }),
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_INCOMPLETE_WAIVER' &&
    diagnostic.waiverId === 'bad-waiver',
  ));
});

test('pipeline coverage registry: #234 agent-question resume is executable DSL coverage, not a waiver', () => {
  const scenario = PIPELINE_COVERAGE_REGISTRY.scenarios.find((candidate) =>
    candidate.id === 'RG234-D-agent-question-resume',
  );

  assert.ok(scenario, '#234 scenario must be registered');
  assert.equal(scenario.ownerSurface, 'src/e2e/pipeline/runner-retry-gate.e2e.test.ts');
  assert.deepEqual(scenario.tags, []);
  assert.equal(
    PIPELINE_COVERAGE_REGISTRY.waivers.some((candidate) => candidate.id.includes('234')),
    false,
    '#234 must not remain covered by a waiver',
  );
});

test('pipeline coverage registry: rejects profile signatures with no DSL owner or waiver', () => {
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: PIPELINE_COVERAGE_REGISTRY.scenarios.map((scenario) => ({
        ...scenario,
        tags: scenario.tags.filter((tag) => !String(tag).includes(':signature:single-review')),
        primaryTags: scenario.primaryTags.filter((tag) => !String(tag).includes(':signature:single-review')),
      })),
      waivers: PIPELINE_COVERAGE_REGISTRY.waivers.filter((waiver) =>
        !(waiver.tags ?? []).some((tag) => String(tag).includes(':signature:single-review')),
      ),
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL' &&
    diagnostic.message.includes('single-review'),
  ));
});

test('pipeline coverage registry: rejects duplicate primary owners', () => {
  const tag = 'node:mergeGate:outcome:cancel' as PipelineCoverageTag;
  const owner = PIPELINE_COVERAGE_REGISTRY.scenarios.find((scenario) => scenario.primaryTags.includes(tag));
  assert.ok(owner);
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: [
        ...PIPELINE_COVERAGE_REGISTRY.scenarios,
        { ...owner, id: 'duplicate-primary', ownerSurface: 'src/e2e/pipeline/gates.e2e.test.ts' },
      ],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_DUPLICATE_OWNER' && diagnostic.tag === tag));
});

test('pipeline coverage registry: production builder rejects duplicate primary owners', () => {
  const tag = 'node:mergeGate:outcome:cancel' as PipelineCoverageTag;
  const owner = PIPELINE_COVERAGE_REGISTRY.scenarios.find((scenario) => scenario.primaryTags.includes(tag));
  assert.ok(owner);

  assert.throws(
    () => definePipelineCoverageRegistry({
      scenarios: [
        ...PIPELINE_COVERAGE_REGISTRY.scenarios,
        {
          id: 'duplicate-through-builder',
          ownerSurface: 'src/e2e/pipeline/gates.e2e.test.ts',
          tags: [tag],
          primaryTags: [tag],
          materialized: { pipelineId: 'feature-development', profileId: 'base' },
        },
      ],
      ownership: PIPELINE_COVERAGE_REGISTRY.ownership,
      waivers: [],
    }),
    /multiple primary owners.*node:mergeGate:outcome:cancel/,
  );
});

test('pipeline coverage registry: corroborating profile tags do not satisfy DSL signature ownership', () => {
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: PIPELINE_COVERAGE_REGISTRY.scenarios.map((scenario) => ({
        ...scenario,
        primaryTags: scenario.primaryTags.filter((tag) =>
          !String(tag).includes(':signature:single-review')),
      })),
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL' &&
    diagnostic.message.includes('single-review')));
});

test('pipeline coverage registry: rejects a cell that is both owned and waived', () => {
  const tag = 'node:mergeGate:outcome:cancel' as PipelineCoverageTag;
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      waivers: [{
        ...waiverForCell({
          id: 'owned-cell-waiver',
          tag,
          reason: 'negative fixture',
          ownerSurface: 'src/testing/policy/pipeline-coverage.test.ts',
          expiry: { stage: 'stage-3' },
        }),
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_OWNED_AND_WAIVED' && diagnostic.tag === tag));
});

test('pipeline coverage registry: validates waiver expiry and keeps the committed set empty', () => {
  assert.deepEqual(PIPELINE_COVERAGE_REGISTRY.waivers, []);
  const tag = 'node:mergeGate:outcome:cancel' as PipelineCoverageTag;
  const withoutPrimary = PIPELINE_COVERAGE_REGISTRY.scenarios.map((scenario) => ({
    ...scenario,
    primaryTags: scenario.primaryTags.filter((candidate) => candidate !== tag),
    primaryCellIds: scenario.primaryCellIds.filter((cellId) => !String(cellId).endsWith(`::${tag}`)),
  }));
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: withoutPrimary,
      waivers: [{
        ...waiverForCell({
          id: 'expired-waiver',
          tag,
          reason: 'temporary fixture',
          ownerSurface: 'src/testing/policy/pipeline-coverage.test.ts',
          expiry: { stage: 'stage-2' },
        }),
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_EXPIRED_WAIVER' && diagnostic.waiverId === 'expired-waiver'));
});

test('pipeline coverage registry: Stage 3 rejects a signature waiver that expires at Stage 3', () => {
  const tag = 'profile:codex-standard:signature:single-review' as PipelineCoverageTag;
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    currentStage: 'stage-3',
    registry: registryWith({
      scenarios: PIPELINE_COVERAGE_REGISTRY.scenarios.map((scenario) => ({
        ...scenario,
        primaryTags: scenario.primaryTags.filter((candidate) => candidate !== tag),
        primaryCellIds: scenario.primaryCellIds.filter((cellId) => !String(cellId).endsWith(`::${tag}`)),
      })),
      waivers: [{
        ...waiverForCell({
          id: 'stage-3-expired-signature',
          tag,
          materialized: materializedIdentity('feature-development', 'codex-standard'),
          reason: 'negative fixture',
          ownerSurface: 'src/testing/policy/pipeline-coverage.test.ts',
          expiry: { stage: 'stage-3' },
        }),
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_EXPIRED_WAIVER' &&
    diagnostic.waiverId === 'stage-3-expired-signature'));
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_SIGNATURE_WITHOUT_DSL' &&
    diagnostic.message.includes('single-review')));
});

test('pipeline coverage registry: negated verdict conditions do not claim positive outcome coverage', () => {
  const template: Template = {
    specVersion: 'test',
    pipelineId: 'synthetic',
    entry: 'router',
    verdicts: { domain: ['approved', 'blocked', 'clean'] },
    nodes: {
      router: {
        id: 'router',
        kind: 'choice',
        branches: [
          {
            when: { op: 'not', cond: { op: 'verdict.eq', value: 'approved' } },
            goto: 'blockedEnd',
          },
          {
            when: {
              op: 'all',
              of: [
                { op: 'not', cond: { op: 'verdict.in', value: ['blocked'] } },
                { op: 'verdict.eq', value: 'clean' },
              ],
            },
            goto: 'cleanEnd',
          },
          { default: 'blockedEnd' },
        ],
      },
      blockedEnd: { id: 'blockedEnd', kind: 'terminal', status: 'blocked' },
      cleanEnd: { id: 'cleanEnd', kind: 'terminal', status: 'succeeded' },
    },
  };

  const tags = graphCoverageTagsForTemplate(template);

  assert.deepEqual(tags, [
    'node:router:default',
    'node:router:outcome:clean',
  ]);
});

test('pipeline coverage registry: routing signatures include all topology stages in sorted order', () => {
  assert.equal(
    routingSignatureForRunProfile({
      id: 'synthetic',
      pipelineId: 'feature-development',
      status: 'active',
      topology: {
        stages: {
          zetaReview: { mode: 'single' },
          planReviewer: { mode: 'consensus', branches: 3 },
          codeReview: { mode: 'consensus', branches: 2 },
        },
      },
    }),
    'codeReview-consensus2__planReviewer-consensus3__zetaReview-single',
  );
});

test('pipeline coverage registry: rejects unknown scenario ids at the attachment point', () => {
  assert.throws(
    () => coverageForScenario('not-registered' as Parameters<typeof coverageForScenario>[0]),
    /unknown pipeline coverage scenario/,
  );
});
