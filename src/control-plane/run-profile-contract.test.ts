import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileExecutionPlan,
  parseExecutionPlan,
  resolveGraphBindings,
  resolveProfileSource,
  selectRunProfile,
  validateRunProfile,
  runnerManifestDigest,
  type RunnerManifest,
} from './run-profile-contract.js';

const manifestSnapshot = {
  runnerId: 'codex',
  manifestVersion: '1',
  stdoutParserId: 'codex-jsonl',
  permissionStyleId: 'codex-sandbox',
  declaredDefaultPermissionMode: 'read-only',
  capabilities: { structuredOutput: true },
  constraints: { allowedProviders: ['openai'], permissionModes: ['read-only', 'workspace-write'] },
  executionFields: { command: 'codex' },
};
const manifest: RunnerManifest = {
  ...manifestSnapshot,
  manifestDigest: runnerManifestDigest({ ...manifestSnapshot, manifestDigest: '' }),
};

const profile = {
  schemaVersion: 'run-profile/v1',
  topology: { stages: { developer: { mode: 'single' } } },
  bindings: {
    slots: {
      'role:developer': {
        runnerId: 'codex',
        provider: 'openai',
        modelId: 'gpt-exact',
        modelParams: { maxTurns: 12 },
      },
      'node:developer': {
        runnerId: 'codex',
        provider: 'openai',
        modelId: 'gpt-node-specific',
        modelParams: {},
        permissionMode: 'workspace-write',
      },
      'node:integrator': { accounts: { github: 'profile-bot' } },
    },
  },
} as const;

test('run-profile contract requires exact agent fields and rejects model-level aliases', () => {
  assert.deepEqual(validateRunProfile(profile).bindings.slots['role:developer'], profile.bindings.slots['role:developer']);

  assert.throws(
    () => validateRunProfile({
      ...profile,
      bindings: { slots: { 'role:developer': { runnerId: 'codex', provider: 'openai', modelId: 'gpt', modelLevel: 'deep' } } },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_schema_invalid',
  );

  assert.throws(
    () => validateRunProfile({
      ...profile,
      bindings: { slots: { 'node:integrator': { accounts: { github: 'profile-bot' }, runnerId: 'codex' } } },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_script_binding_invalid',
  );

  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { 'role:developer': { accounts: { github: 'profile-bot' } } } },
    }), {
      nodes: [
        { id: 'developer', kind: 'agent', roleRef: 'role:developer' },
        { id: 'integrator', kind: 'script', scriptRef: 'script:integrator' },
      ],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: manifest },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_script_binding_invalid',
  );
});

test('run-profile contract rejects unsupported profile permission modes with a stable path', () => {
  const constrainedManifestSnapshot = {
    ...manifestSnapshot,
    constraints: { ...manifestSnapshot.constraints, permissionModes: ['read-only'] },
  };
  const constrainedManifest = {
    ...constrainedManifestSnapshot,
    manifestDigest: runnerManifestDigest({ ...constrainedManifestSnapshot, manifestDigest: '' }),
  };

  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { 'node:developer': profile.bindings.slots['node:developer'] } },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: constrainedManifest },
    }),
    (error: unknown) => {
      const contractError = error as { code?: string; path?: string };
      return contractError.code === 'runner_permission_invalid'
        && contractError.path === 'node:developer.permissionMode';
    },
  );
});

test('run-profile contract rejects unsupported model parameters with a stable path', () => {
  const constrainedManifestSnapshot = {
    ...manifestSnapshot,
    constraints: { ...manifestSnapshot.constraints, modelParamKeys: ['temperature'] },
  };
  const constrainedManifest = {
    ...constrainedManifestSnapshot,
    manifestDigest: runnerManifestDigest({ ...constrainedManifestSnapshot, manifestDigest: '' }),
  };

  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: {
        slots: {
          'node:developer': { ...profile.bindings.slots['node:developer'], modelParams: { maxTurns: 12 } },
        },
      },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: constrainedManifest },
    }),
    (error: unknown) => {
      const contractError = error as { code?: string; path?: string };
      return contractError.code === 'model_config_invalid'
        && contractError.path === 'node:developer.modelParams';
    },
  );
});

test('run-profile contract uses canonical node slots before role slots and keeps script accounts separate', () => {
  const resolved = resolveGraphBindings(validateRunProfile(profile), {
    nodes: [
      { id: 'developer', kind: 'agent', roleRef: 'role:developer' },
      { id: 'integrator', kind: 'script', scriptRef: 'script:integrator' },
    ],
    roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
    runnerManifests: { codex: manifest },
  });

  assert.equal(resolved.agentBindings[0]?.modelId, 'gpt-node-specific');
  assert.equal(resolved.agentBindings[0]?.permissionMode, 'workspace-write');
  assert.equal(resolved.agentBindings[0]?.permissionSource, 'profile');
  assert.equal(resolved.agentBindings[0]?.runner.manifestDigest, manifest.manifestDigest);
  assert.deepEqual(resolved.scriptBindings, [{
    nodeId: 'integrator',
    scriptRef: 'script:integrator',
    accountAliases: { github: 'profile-bot' },
  }]);
});

test('execution plans normalize JSON business params and reject non-JSON values', () => {
  const base = {
    selection: { playbookId: 'pb', pipelineId: 'local-change', pipelineRowId: 'row', source: 'explicit' as const },
    businessParams: { nested: { keep: true } },
    profile: { source: 'inline' as const, profileHash: 'sha256:' + '0'.repeat(64) },
    pipeline: { executableGraph: {}, graphDigest: 'sha256:' + '1'.repeat(64), materializerVersion: '1', policyVersion: '1', routeGates: [], executionPolicy: {} },
    agentBindings: [],
    scriptBindings: [],
  };
  const compiled = compileExecutionPlan({ ...base, businessParams: { nested: { keep: true } } });
  assert.deepEqual(compiled.plan.businessParams, { nested: { keep: true } });
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
    assert.throws(() => compileExecutionPlan({ ...base, businessParams: { nested: { value } } }), /must contain JSON values/);
  }
});

test('runner manifest snapshots reject secret-bearing execution fields', () => {
  const secretManifest = { ...manifestSnapshot, executionFields: { command: 'codex', apiToken: 'secret' } };
  assert.throws(
    () => resolveGraphBindings(validateRunProfile(profile), {
      nodes: [
        { id: 'developer', kind: 'agent', roleRef: 'role:developer' },
        { id: 'integrator', kind: 'script', scriptRef: 'script:integrator' },
      ],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: { ...secretManifest, manifestDigest: runnerManifestDigest({ ...secretManifest, manifestDigest: '' }) } },
    }),
    (error: unknown) => (error as { code?: string; path?: string }).code === 'runner_manifest_unresolved' && (error as { path?: string }).path?.includes('apiToken') === true,
  );
});

test('run-profile contract rejects unbound and non-obligation slots without fallback', () => {
  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: {} },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: manifest },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_binding_unresolved',
  );

  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { ...profile.bindings.slots, 'role:unused': profile.bindings.slots['role:developer'] } },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: manifest },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_slot_unknown',
  );
});

test('stored and inline profile selectors are exclusive and plan bytes are canonical', () => {
  assert.deepEqual(selectRunProfile({ profileId: 'stored' }), { source: 'stored', profileId: 'stored' });
  assert.deepEqual(selectRunProfile({ profile }), { source: 'inline', profile });
  assert.throws(
    () => selectRunProfile({ profileId: 'stored', profile }),
    (error: unknown) => (error as { code?: string }).code === 'profile_selector_invalid',
  );

  const compiled = compileExecutionPlan({
    selection: { playbookId: 'playbook', pipelineId: 'pipeline', pipelineRowId: 'pipeline-row', source: 'explicit' },
    businessParams: { issueRef: { number: 1 } },
    profile: { source: 'inline', profileHash: 'sha256:profile' },
    pipeline: {
      executableGraph: { nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }] },
      graphDigest: 'sha256:graph',
      materializerVersion: '1',
      policyVersion: '1',
      routeGates: [],
      executionPolicy: { maxAttempts: 1 },
    },
    ...resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { 'node:developer': profile.bindings.slots['node:developer'] } },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: manifest },
    }),
  });

  assert.match(compiled.bytes, /executionPlanDigest/);
  assert.match(compiled.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(compiled.plan.executionPlanDigest, compiled.digest);
  assert.equal(compiled.plan.agentBindings[0]?.runner.executionFields.command, 'codex');
  assert.equal((compiled.plan.businessParams.issueRef as { number: number }).number, 1);

  assert.throws(
    () => parseExecutionPlan(compiled.bytes.replace('gpt-node-specific', 'gpt-tampered'), compiled.digest),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_invalid',
  );
  assert.throws(
    () => parseExecutionPlan(compiled.bytes.replace(compiled.plan.executionPlanId, 'execution-plan:tampered'), compiled.digest),
    (error: unknown) => (error as { code?: string }).code === 'execution_plan_invalid',
  );
});

test('stored and inline profile bodies use the same shared normalization resolver', async () => {
  const inline = await resolveProfileSource({ profile }, async () => {
    throw new Error('stored profile loader must not be called for inline input');
  });
  const stored = await resolveProfileSource({ profileId: 'stored' }, async () => ({
    profile,
    profileId: 'stored',
    profileVersion: '1',
    profileHash: 'sha256:profile',
    pipelineId: 'local-change',
    schemaVersion: 'run-profile/v1',
  }));
  assert.deepEqual(inline.profile, stored.profile);
  assert.equal(inline.source, 'inline');
  assert.equal(stored.source, 'stored');
  assert.equal(stored.profileId, 'stored');
});

test('runner manifest constraints reject provider mismatch and invalid defaults without fallback', () => {
  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { 'node:developer': { ...profile.bindings.slots['node:developer'], provider: 'anthropic' } } },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: { codex: manifest },
    }),
    (error: unknown) => (error as { code?: string }).code === 'runner_provider_mismatch',
  );

  assert.throws(
    () => resolveGraphBindings(validateRunProfile({
      ...profile,
      bindings: { slots: { 'node:developer': profile.bindings.slots['node:developer'] } },
    }), {
      nodes: [{ id: 'developer', kind: 'agent', roleRef: 'role:developer' }],
      roleDocuments: { developer: { roleDocumentId: 'role-doc-developer' } },
      runnerManifests: {
        codex: (() => {
          const snapshot = { ...manifest, declaredDefaultPermissionMode: 'not-allowed' };
          return { ...snapshot, manifestDigest: runnerManifestDigest(snapshot) };
        })(),
      },
    }),
    (error: unknown) => (error as { code?: string }).code === 'runner_permission_default_invalid',
  );
});
