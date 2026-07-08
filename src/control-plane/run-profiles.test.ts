import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { materializeTemplate } from '../pipeline-core/materialize.js';
import { templateFromExecutionPolicy } from '../pipeline/data-driven-template.js';
import type { BindingOverride } from '../pipeline/route-contract.js';
import { launchBindingsFromRunProfile, runProfileHash, topologyProfileFromRunProfile } from './run-profiles.js';

type PipelineCatalogEntry = {
  id: string;
  execution_policy: unknown;
};

type RunProfileCatalogEntry = {
  id: string;
  pipelineId: string;
  topology: unknown;
  bindings: unknown;
  status: string;
};

const ROLE_SLOTS = new Set([
  'orchestrator',
  'analyst',
  'reviewer',
  'developer',
  'integrator',
  'watcher',
  'triager',
]);

const pipelines = JSON.parse(
  readFileSync(new URL('../../control-plane/default-playbook/catalog/pipelines.json', import.meta.url), 'utf8'),
) as PipelineCatalogEntry[];

const runProfiles = JSON.parse(
  readFileSync(new URL('../../control-plane/default-playbook/catalog/run-profiles.json', import.meta.url), 'utf8'),
) as RunProfileCatalogEntry[];

function featureDevelopmentTemplate() {
  const pipeline = pipelines.find((candidate) => candidate.id === 'feature-development');
  assert.ok(pipeline, 'feature-development pipeline exists');
  const template = templateFromExecutionPolicy(pipeline.execution_policy);
  assert.ok(template, 'feature-development carries template_json');
  return template;
}

function profile(id: string): RunProfileCatalogEntry {
  const found = runProfiles.find((candidate) => candidate.id === id);
  assert.ok(found, `${id} profile exists`);
  return found;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function slotKey(slot: string): string {
  if (slot.startsWith('role:') || slot.startsWith('node:')) return slot;
  return ROLE_SLOTS.has(slot) ? `role:${slot}` : `node:${slot}`;
}

function overrideKey(override: BindingOverride): string {
  if ('roleId' in override.match) return `role:${override.match.roleId}`;
  return `node:${override.match.nodeId}`;
}

test('run profiles: catalog consensus profile materializes plan and code review fanout', () => {
  const { template, diagnostics } = materializeTemplate(
    featureDevelopmentTemplate(),
    topologyProfileFromRunProfile(profile('codex-primary-claude-review-consensus') as never),
    { allowlist: ['planReviewer', 'codeReview'] },
  );

  assert.deepEqual(diagnostics, []);
  assert.ok(template.nodes.planReviewFanout, 'plan review fanout is materialized');
  assert.ok(template.nodes.codeReviewFanout, 'code review fanout is materialized');
});

for (const candidate of runProfiles) {
  test(`run profiles: catalog bindings for ${candidate.id} become launch overrides`, () => {
    const overrides = launchBindingsFromRunProfile(candidate as never);
    const bySlot = new Map(overrides.map((override) => [overrideKey(override), override]));
    const slots = asRecord(asRecord(candidate.bindings).slots);

    assert.equal(overrides.length, Object.keys(slots).length);
    for (const [slot, rawBinding] of Object.entries(slots)) {
      const binding = asRecord(rawBinding);
      const actual = bySlot.get(slotKey(slot));
      assert.ok(actual, `${candidate.id} binding ${slot} must produce an override`);
      assert.equal(actual.runnerId, binding.runnerId);
      assert.equal(actual.modelLevel, binding.modelLevel);
      assert.equal(actual.timeoutMs, binding.timeoutMs);
      assert.equal(actual.permissionMode, binding.permissionMode);
    }
  });
}

test('run profiles: catalog bindings become role and node launch overrides', () => {
  const overrides = launchBindingsFromRunProfile(profile('codex-primary-claude-review-consensus') as never);
  const byRole = new Map(
    overrides
      .filter((override) => 'roleId' in override.match)
      .map((override) => [(override.match as { roleId: string }).roleId, override]),
  );
  const byNode = new Map(
    overrides
      .filter((override) => 'nodeId' in override.match)
      .map((override) => [(override.match as { nodeId: string }).nodeId, override]),
  );

  assert.equal(byRole.get('developer')?.runnerId, 'codex');
  assert.equal(byRole.get('developer')?.modelLevel, 'codex-standard');
  assert.equal(byNode.get('planReviewPrimary')?.runnerId, 'codex');
  assert.equal(byNode.get('planReviewSecondary')?.runnerId, 'claude-code');
  assert.equal(
    (byNode.get('codeReviewPrimary') as BindingOverride | undefined)?.modelLevel,
    'codex-deep',
  );
});

test('run profiles: canonical hash ignores display-only fields', () => {
  const base = profile('codex-standard') as never as Record<string, unknown>;
  const changed = { ...base, displayName: 'Changed label', summary: 'Changed summary', status: 'deprecated' };

  assert.equal(runProfileHash(base), runProfileHash(changed));
});

test('run profiles: canonical hash is stable across object insertion order', () => {
  const left = {
    pipelineId: 'analysis-only',
    schemaVersion: 'run-profile/v1',
    topology: { stages: { analyst: { mode: 'single' } } },
    bindings: {
      slots: {
        analyst: { runnerId: 'codex', modelLevel: 'codex-deep' },
        orchestrator: { runnerId: 'codex', modelLevel: 'codex-deep' },
      },
    },
  };
  const right = {
    bindings: {
      slots: {
        orchestrator: { modelLevel: 'codex-deep', runnerId: 'codex' },
        analyst: { modelLevel: 'codex-deep', runnerId: 'codex' },
      },
    },
    topology: { stages: { analyst: { mode: 'single' } } },
    schemaVersion: 'run-profile/v1',
    pipelineId: 'analysis-only',
  };

  assert.equal(runProfileHash(left), runProfileHash(right));
});

test('run profiles: launch bindings are stable across object insertion order', () => {
  const left = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: {
      slots: {
        reviewer: { runnerId: 'claude-code', modelLevel: 'deep' },
        developer: { runnerId: 'codex', modelLevel: 'codex-standard' },
      },
    },
  };
  const right = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: {
      slots: {
        developer: { runnerId: 'codex', modelLevel: 'codex-standard' },
        reviewer: { runnerId: 'claude-code', modelLevel: 'deep' },
      },
    },
  };

  assert.deepEqual(launchBindingsFromRunProfile(left), launchBindingsFromRunProfile(right));
  assert.deepEqual(
    launchBindingsFromRunProfile(left).map((override) => overrideKey(override)),
    ['role:developer', 'role:reviewer'],
  );
});

test('run profiles: canonical hash includes selected pipeline context outside the payload', () => {
  const payload = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: {} },
    bindings: { slots: {} },
  };

  assert.notEqual(
    runProfileHash(payload, { pipelineId: 'local-change' }),
    runProfileHash(payload, { pipelineId: 'analysis-only' }),
  );
});
