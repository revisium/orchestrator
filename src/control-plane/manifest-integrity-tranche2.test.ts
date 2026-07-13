import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileExecutionPlan,
  parseExecutionPlan,
  resolveGraphBindings,
  validateRunProfile,
} from './run-profile-contract.js';
import { RUNNER_MANIFESTS } from '../runners/runner-manifest.js';

const profile = validateRunProfile({
  schemaVersion: 'run-profile/v1',
  topology: { stages: { developer: { mode: 'single' } } },
  bindings: {
    slots: {
      'node:developer': {
        runnerId: 'codex',
        provider: 'openai',
        modelId: 'gpt-5.6-luna',
        modelParams: {},
      },
    },
  },
});

function resolve() {
  return resolveGraphBindings(profile, {
    nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
    roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
    runnerManifests: { codex: RUNNER_MANIFESTS.codex },
  });
}

test('runner manifests use real sha256 digests of their canonical snapshots', () => {
  for (const manifest of Object.values(RUNNER_MANIFESTS)) {
    assert.match(manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/);
  }
});

test('route resolution and plan parsing reject a digest that is not the pinned snapshot digest', () => {
  const tamperedManifest = {
    ...RUNNER_MANIFESTS.codex,
    manifestDigest: `sha256:${'0'.repeat(64)}`,
  };

  assert.throws(
    () => resolveGraphBindings(profile, {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: tamperedManifest },
    }),
    (error: unknown) => (error as { code?: string }).code === 'runner_manifest_unresolved',
  );

  const compiled = compileExecutionPlan({
    selection: { playbookId: 'playbook', pipelineId: 'pipeline', pipelineRowId: 'pipeline-row', source: 'explicit' },
    businessParams: {},
    profile: { source: 'inline', profileHash: 'sha256:profile' },
    pipeline: {
      executableGraph: { nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }] },
      graphDigest: 'sha256:graph',
      materializerVersion: '1',
      policyVersion: '1',
      routeGates: [],
      executionPolicy: {},
    },
    ...resolve(),
  });
  const tamperedBytes = compiled.bytes.replace(
    RUNNER_MANIFESTS.codex.manifestDigest,
    `sha256:${'1'.repeat(64)}`,
  );
  assert.throws(
    () => parseExecutionPlan(tamperedBytes, compiled.digest),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_invalid',
  );

  const tamperedProviderBytes = compiled.bytes.replace('"provider":"openai"', '"provider":"anthropic"');
  assert.notEqual(tamperedProviderBytes, compiled.bytes);
  assert.throws(
    () => parseExecutionPlan(tamperedProviderBytes, compiled.digest),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_invalid',
  );
});

test('plan compilation validates provider and effective permission against the pinned manifest', () => {
  const resolved = resolve();
  const base = {
    selection: { playbookId: 'playbook', pipelineId: 'pipeline', pipelineRowId: 'pipeline-row', source: 'explicit' as const },
    businessParams: {},
    profile: { source: 'inline' as const, profileHash: 'sha256:profile' },
    pipeline: {
      executableGraph: { nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }] },
      graphDigest: 'sha256:graph',
      materializerVersion: '1',
      policyVersion: '1',
      routeGates: [],
      executionPolicy: {},
    },
    scriptBindings: resolved.scriptBindings,
  };

  assert.throws(
    () => compileExecutionPlan({
      ...base,
      agentBindings: [{ ...resolved.agentBindings[0]!, provider: 'anthropic' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_binding_unresolved',
  );

  assert.throws(
    () => compileExecutionPlan({
      ...base,
      agentBindings: [{ ...resolved.agentBindings[0]!, permissionMode: 'workspace-write', permissionSource: 'runner-manifest-default' }],
    }),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_binding_unresolved',
  );
});
