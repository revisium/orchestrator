import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeExecutionProfile,
  resolveBindingForRole,
  resolveLaunchOverrides,
  resolveRunnerForRole,
  RUNNER_PERMISSION_MODES,
  type ExecutionProfile,
  type RouteRoleBinding,
} from './route-contract.js';

function makeProfile(overrides: Partial<ExecutionProfile> = {}): ExecutionProfile {
  return {
    id: 'default',
    runnerOverrides: {},
    ...overrides,
  };
}

function makeBinding(overrides: Partial<RouteRoleBinding> = {}): RouteRoleBinding {
  return {
    roleId: 'analyst',
    rowId: 'analyst',
    modelLevel: 'standard',
    runnerId: 'claude-code',
    resolvedRunnerId: 'claude-code',
    runnerSource: 'playbook',
    ...overrides,
  };
}

test('normalizeExecutionProfile: no bindingOverrides field -> bindingOverrides absent', () => {
  const result = normalizeExecutionProfile({ id: 'p1' });
  assert.equal(result.bindingOverrides, undefined);
});

test('normalizeExecutionProfile: camelCase bindingOverrides parsed', () => {
  const result = normalizeExecutionProfile({
    bindingOverrides: [{ match: { roleId: 'analyst' }, modelLevel: 'deep' }],
  });
  assert.equal(result.bindingOverrides?.length, 1);
  assert.deepEqual(result.bindingOverrides?.[0]?.match, { roleId: 'analyst' });
  assert.equal(result.bindingOverrides?.[0]?.modelLevel, 'deep');
});

test('normalizeExecutionProfile: snake_case binding_overrides parsed', () => {
  const result = normalizeExecutionProfile({
    binding_overrides: [{ match: { roleId: 'developer' }, timeoutMs: 60000 }],
  });
  assert.equal(result.bindingOverrides?.length, 1);
  assert.equal(result.bindingOverrides?.[0]?.timeoutMs, 60000);
});

test('normalizeExecutionProfile: preserves an invalid timeoutMs instead of silently dropping it (PROFILE_SCHEMA_CLOSED)', () => {
  const result = normalizeExecutionProfile({
    bindingOverrides: [{ match: { roleId: 'developer' }, timeoutMs: -5 }],
  });
  assert.equal(
    result.bindingOverrides?.[0]?.timeoutMs,
    -5,
    'an invalid timeoutMs must survive normalization so Phase A validation can reject it, not vanish into undefined',
  );
});

test('normalizeExecutionProfile: ignores entries without match', () => {
  const result = normalizeExecutionProfile({
    bindingOverrides: [{ modelLevel: 'deep' }, { match: { roleId: 'analyst' }, modelLevel: 'cheap' }],
  });
  assert.equal(result.bindingOverrides?.length, 1);
  assert.equal(result.bindingOverrides?.[0]?.modelLevel, 'cheap');
});

test('normalizeExecutionProfile: garbage entries ignored', () => {
  const result = normalizeExecutionProfile({
    bindingOverrides: [null, 'string', 42, { match: { roleId: 'r' } }],
  });
  assert.equal(result.bindingOverrides?.length, 1);
});

test('normalizeExecutionProfile: runnerOverrides and availableRunners unchanged', () => {
  const result = normalizeExecutionProfile({
    runnerOverrides: { 'claude-code': 'codex' },
    availableRunners: ['claude-code', 'codex'],
    bindingOverrides: [{ match: { roleId: 'x' }, modelLevel: 'deep' }],
  });
  assert.equal(result.runnerOverrides['claude-code'], 'codex');
  assert.deepEqual(result.availableRunners, ['claude-code', 'codex']);
});

test('resolveBindingForRole: no overrides -> playbook source for all axes', () => {
  const profile = makeProfile();
  const role = { modelLevel: 'standard', timeoutMs: 60000, permissionMode: 'default' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.modelSource, 'playbook');
  assert.equal(result.resolvedTimeoutMs, 60000);
  assert.equal(result.timeoutSource, 'playbook');
  assert.equal(result.resolvedPermissionMode, 'default');
  assert.equal(result.permissionSource, 'playbook');
});

test('resolveBindingForRole: roleId match overrides all specified axes', () => {
  const profile = makeProfile({
    bindingOverrides: [{ match: { roleId: 'analyst' }, modelLevel: 'deep', timeoutMs: 120000 }],
  });
  const role = { modelLevel: 'standard', timeoutMs: 60000 };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'deep');
  assert.equal(result.modelSource, 'execution-profile');
  assert.equal(result.resolvedTimeoutMs, 120000);
  assert.equal(result.timeoutSource, 'execution-profile');
});

test('resolveBindingForRole: runnerId match overrides when no roleId match', () => {
  const profile = makeProfile({
    bindingOverrides: [{ match: { runnerId: 'claude-code' }, modelLevel: 'cheap' }],
  });
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'cheap');
  assert.equal(result.modelSource, 'execution-profile');
});

test('resolveBindingForRole: roleId match wins over runnerId match', () => {
  const profile = makeProfile({
    bindingOverrides: [
      { match: { runnerId: 'claude-code' }, modelLevel: 'cheap' },
      { match: { roleId: 'analyst' }, modelLevel: 'deep' },
    ],
  });
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'deep');
});

test('resolveBindingForRole: later roleId match wins over earlier profile defaults', () => {
  const profile = makeProfile({
    bindingOverrides: [
      { match: { roleId: 'analyst' }, modelLevel: 'deep' },
      { match: { roleId: 'analyst' }, modelLevel: 'standard' },
    ],
  });
  const role = { modelLevel: 'cheap' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'standard');
});

test('resolveRunnerForRole: role binding runnerId overrides playbook runner and still honors runnerOverrides', () => {
  const profile = makeProfile({
    runnerOverrides: { codex: 'stub-agent' },
    bindingOverrides: [{ match: { roleId: 'developer' }, runnerId: 'codex' }],
  });

  const result = resolveRunnerForRole('claude-code', 'developer', profile);

  assert.equal(result.runnerId, 'stub-agent');
  assert.equal(result.source, 'execution-profile');
});

test('resolveBindingForRole: partial override - only overridden axes get execution-profile source', () => {
  const profile = makeProfile({
    bindingOverrides: [{ match: { roleId: 'analyst' }, timeoutMs: 90000 }],
  });
  const role = { modelLevel: 'standard', timeoutMs: 60000, permissionMode: 'plan' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.modelSource, 'playbook');
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.timeoutSource, 'execution-profile');
  assert.equal(result.resolvedTimeoutMs, 90000);
  assert.equal(result.permissionSource, 'playbook');
  assert.equal(result.resolvedPermissionMode, 'plan');
});

test('resolveBindingForRole: no timeoutMs on role and no override -> timeoutSource absent', () => {
  const profile = makeProfile();
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedTimeoutMs, undefined);
  assert.equal(result.timeoutSource, undefined);
});

test('resolveBindingForRole: nodeId-only override not matched at route time', () => {
  const profile = makeProfile({
    bindingOverrides: [{ match: { nodeId: 'n1' }, modelLevel: 'deep' }],
  });
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', profile);
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.modelSource, 'playbook');
});

test('resolveLaunchOverrides: no binding overrides + no node match -> undefined', () => {
  const profile = makeProfile();
  const binding = makeBinding();
  const result = resolveLaunchOverrides(binding, 'n1', profile);
  assert.equal(result, undefined);
});

test('resolveLaunchOverrides: binding has execution-profile sources -> returned as LaunchOverrides', () => {
  const profile = makeProfile();
  const binding = makeBinding({
    resolvedModelLevel: 'deep',
    modelSource: 'execution-profile',
    resolvedTimeoutMs: 120000,
    timeoutSource: 'execution-profile',
  });
  const result = resolveLaunchOverrides(binding, 'n1', profile);
  assert.ok(result !== undefined);
  assert.equal(result?.modelLevel, 'deep');
  assert.equal(result?.timeoutMs, 120000);
});

test('resolveLaunchOverrides: playbook sources on binding -> undefined (no overrides)', () => {
  const profile = makeProfile();
  const binding = makeBinding({
    resolvedModelLevel: 'standard',
    modelSource: 'playbook',
  });
  const result = resolveLaunchOverrides(binding, 'n1', profile);
  assert.equal(result, undefined);
});

test('resolveLaunchOverrides: nodeId match wins over binding per-role values', () => {
  const profile = makeProfile({
    bindingOverrides: [{ match: { nodeId: 'n1' }, modelLevel: 'cheap', timeoutMs: 30000 }],
  });
  const binding = makeBinding({
    resolvedModelLevel: 'deep',
    modelSource: 'execution-profile',
    resolvedTimeoutMs: 120000,
    timeoutSource: 'execution-profile',
  });
  const result = resolveLaunchOverrides(binding, 'n1', profile);
  assert.ok(result !== undefined);
  assert.equal(result?.modelLevel, 'cheap');
  assert.equal(result?.timeoutMs, 30000);
});

test('resolveLaunchOverrides: later nodeId override wins over stored profile defaults', () => {
  const profile = makeProfile({
    bindingOverrides: [
      { match: { nodeId: 'n1' }, runnerId: 'codex', modelLevel: 'codex-standard' },
      { match: { nodeId: 'n1' }, runnerId: 'claude-code', modelLevel: 'deep' },
    ],
  });
  const result = resolveLaunchOverrides(makeBinding(), 'n1', profile);

  assert.equal(result?.runnerId, 'claude-code');
  assert.equal(result?.modelLevel, 'deep');
});

test('resolveLaunchOverrides: nodeId runner override still honors runnerOverrides', () => {
  const profile = makeProfile({
    runnerOverrides: { codex: 'stub-agent' },
    bindingOverrides: [{ match: { nodeId: 'codeReviewPrimary' }, runnerId: 'codex', modelLevel: 'codex-deep' }],
  });

  const result = resolveLaunchOverrides(makeBinding(), 'codeReviewPrimary', profile);

  assert.equal(result?.runnerId, 'stub-agent');
  assert.equal(result?.modelLevel, 'codex-deep');
});

test('RUNNER_PERMISSION_MODES: claude-code has expected modes', () => {
  const modes = RUNNER_PERMISSION_MODES['claude-code'];
  assert.ok(Array.isArray(modes));
  assert.ok(modes.includes('default'));
  assert.ok(modes.includes('acceptEdits'));
  assert.ok(modes.includes('plan'));
  assert.ok(modes.includes('bypassPermissions'));
  assert.equal(modes.includes('read-only'), false);
});

test('RUNNER_PERMISSION_MODES: codex has expected modes', () => {
  const modes = RUNNER_PERMISSION_MODES['codex'];
  assert.ok(Array.isArray(modes));
  assert.ok(modes.includes('read-only'));
  assert.ok(modes.includes('workspace-write'));
  assert.equal(modes.includes('default'), false);
  assert.equal(modes.includes('bypassPermissions'), false);
});
