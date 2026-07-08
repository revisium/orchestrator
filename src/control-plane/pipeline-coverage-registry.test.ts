import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../config.js';
import type { Template } from '../pipeline-core/types.js';
import type { PipelineCoverageRegistry, PipelineCoverageTag } from './pipeline-coverage-registry.js';
import {
  PIPELINE_COVERAGE_REGISTRY,
  coverageForScenario,
  graphCoverageTagsForTemplate,
  routingSignatureForRunProfile,
  validatePipelineCoverageRegistry,
} from './pipeline-coverage-registry.js';

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readOwnerSurface(ownerSurface: string): string {
  const source = readFileSync(join(repoRoot, ownerSurface), 'utf8');
  assert.ok(source.trim().length > 0, `${ownerSurface} must exist and be non-empty`);
  return source;
}

test('pipeline coverage registry: bundled default graph and profile tags are fully owned', () => {
  assert.deepEqual(validatePipelineCoverageRegistry({ pipelines, runProfiles }), []);
});

test('pipeline coverage registry: every DSL scenario is attached to its executable owner surface', () => {
  const sourceBySurface = new Map<string, string>();

  for (const scenario of PIPELINE_COVERAGE_REGISTRY.scenarios) {
    let source = sourceBySurface.get(scenario.ownerSurface);
    if (!source) {
      source = readOwnerSurface(scenario.ownerSurface);
      sourceBySurface.set(scenario.ownerSurface, source);
    }
    const directAttachment = new RegExp(
      `coverageForScenario\\(\\s*['"]${escapeRegExp(scenario.id)}['"]\\s*\\)`,
    );
    assert.match(
      source,
      directAttachment,
      `${scenario.id} must appear as coverageForScenario('${scenario.id}') in ${scenario.ownerSurface}`,
    );
  }
});

test('pipeline coverage registry: static, unit, and waiver owner surfaces exist', () => {
  const ownerSurfaces = new Set<string>();
  for (const ownership of PIPELINE_COVERAGE_REGISTRY.ownership) ownerSurfaces.add(ownership.ownerSurface);
  for (const waiver of PIPELINE_COVERAGE_REGISTRY.waivers) ownerSurfaces.add(waiver.ownerSurface);

  for (const ownerSurface of ownerSurfaces) {
    readOwnerSurface(ownerSurface);
  }
});

test('pipeline coverage registry: rejects undefined DSL tags', () => {
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      scenarios: [{
        id: 'bad-scenario',
        ownerSurface: 'src/e2e/bad.e2e.test.ts',
        tags: ['node:noSuchNode:outcome:approved' as PipelineCoverageTag],
      }],
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNDEFINED_TAG' &&
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
      })),
      ownership: PIPELINE_COVERAGE_REGISTRY.ownership.map((owner) => ({
        ...owner,
        tags: owner.tags.filter((tag) => tag !== unownedTag),
      })),
      waivers: PIPELINE_COVERAGE_REGISTRY.waivers.map((waiver) => ({
        ...waiver,
        tags: waiver.tags?.filter((tag) => tag !== unownedTag),
      })),
    }),
  });

  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'PIPELINE_COVERAGE_UNOWNED_TAG' &&
    diagnostic.tag === unownedTag,
  ));
});

test('pipeline coverage registry: rejects incomplete waivers', () => {
  const diagnostics = validatePipelineCoverageRegistry({
    pipelines,
    runProfiles,
    registry: registryWith({
      waivers: [{
        id: 'bad-waiver',
        reason: '',
        ownerSurface: '',
        tags: ['node:mergeGate:outcome:cancel'],
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
  assert.equal(scenario.ownerSurface, 'src/e2e/runner-retry-gate.e2e.test.ts');
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
