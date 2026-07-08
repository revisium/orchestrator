import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeParams,
  resolveBindingForRole,
  resolveLaunchOverrides,
  resolveRunnerForRole,
  RUNNER_PERMISSION_MODES,
  type BindingOverride,
  type RouteRoleBinding,
} from './route-contract.js';

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

test('normalizeParams keeps ordinary profile-shaped business params inert', () => {
  const result = normalizeParams({
    launchProfileDraft: { ignored: true },
    runnerSelectionDraft: { ignored: true },
    ticket: 'ABC-1',
  });

  assert.deepEqual(result, {
    launchProfileDraft: { ignored: true },
    runnerSelectionDraft: { ignored: true },
    ticket: 'ABC-1',
  });
});

test('resolveBindingForRole: no profile bindings uses playbook source for all axes', () => {
  const role = { modelLevel: 'standard', timeoutMs: 60000, permissionMode: 'default' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', []);
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.modelSource, 'playbook');
  assert.equal(result.resolvedTimeoutMs, 60000);
  assert.equal(result.timeoutSource, 'playbook');
  assert.equal(result.resolvedPermissionMode, 'default');
  assert.equal(result.permissionSource, 'playbook');
});

test('resolveBindingForRole: roleId match overrides specified axes from profile', () => {
  const bindings: BindingOverride[] = [{ match: { roleId: 'analyst' }, modelLevel: 'deep', timeoutMs: 120000 }];
  const role = { modelLevel: 'standard', timeoutMs: 60000 };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', bindings);
  assert.equal(result.resolvedModelLevel, 'deep');
  assert.equal(result.modelSource, 'profile');
  assert.equal(result.resolvedTimeoutMs, 120000);
  assert.equal(result.timeoutSource, 'profile');
});

test('resolveBindingForRole: runnerId match overrides when no roleId match', () => {
  const bindings: BindingOverride[] = [{ match: { runnerId: 'claude-code' }, modelLevel: 'cheap' }];
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', bindings);
  assert.equal(result.resolvedModelLevel, 'cheap');
  assert.equal(result.modelSource, 'profile');
});

test('resolveBindingForRole: roleId match wins over runnerId match', () => {
  const bindings: BindingOverride[] = [
    { match: { runnerId: 'claude-code' }, modelLevel: 'cheap' },
    { match: { roleId: 'analyst' }, modelLevel: 'deep' },
  ];
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', bindings);
  assert.equal(result.resolvedModelLevel, 'deep');
});

test('resolveRunnerForRole: role binding runnerId overrides playbook runner', () => {
  const bindings: BindingOverride[] = [{ match: { roleId: 'developer' }, runnerId: 'codex' }];

  const result = resolveRunnerForRole('claude-code', 'developer', bindings);

  assert.equal(result.runnerId, 'codex');
  assert.equal(result.source, 'profile');
});

test('resolveBindingForRole: partial override marks only overridden axes as profile source', () => {
  const bindings: BindingOverride[] = [{ match: { roleId: 'analyst' }, timeoutMs: 90000 }];
  const role = { modelLevel: 'standard', timeoutMs: 60000, permissionMode: 'plan' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', bindings);
  assert.equal(result.modelSource, 'playbook');
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.timeoutSource, 'profile');
  assert.equal(result.resolvedTimeoutMs, 90000);
  assert.equal(result.permissionSource, 'playbook');
  assert.equal(result.resolvedPermissionMode, 'plan');
});

test('resolveBindingForRole: nodeId-only override is not matched at role route time', () => {
  const bindings: BindingOverride[] = [{ match: { nodeId: 'n1' }, modelLevel: 'deep' }];
  const role = { modelLevel: 'standard' };
  const result = resolveBindingForRole(role, 'analyst', 'claude-code', bindings);
  assert.equal(result.resolvedModelLevel, 'standard');
  assert.equal(result.modelSource, 'playbook');
});

test('resolveLaunchOverrides: no profile binding and no profile-sourced role binding returns undefined', () => {
  const result = resolveLaunchOverrides(makeBinding(), 'n1', []);
  assert.equal(result, undefined);
});

test('resolveLaunchOverrides: profile-sourced role binding becomes launch overrides', () => {
  const binding = makeBinding({
    resolvedModelLevel: 'deep',
    modelSource: 'profile',
    resolvedTimeoutMs: 120000,
    timeoutSource: 'profile',
  });
  const result = resolveLaunchOverrides(binding, 'n1', []);
  assert.ok(result !== undefined);
  assert.equal(result?.modelLevel, 'deep');
  assert.equal(result?.timeoutMs, 120000);
});

test('resolveLaunchOverrides: playbook-sourced role binding returns undefined', () => {
  const binding = makeBinding({
    resolvedModelLevel: 'standard',
    modelSource: 'playbook',
  });
  const result = resolveLaunchOverrides(binding, 'n1', []);
  assert.equal(result, undefined);
});

test('resolveLaunchOverrides: nodeId match wins over role-level profile values', () => {
  const bindings: BindingOverride[] = [{ match: { nodeId: 'n1' }, modelLevel: 'cheap', timeoutMs: 30000 }];
  const binding = makeBinding({
    resolvedModelLevel: 'deep',
    modelSource: 'profile',
    resolvedTimeoutMs: 120000,
    timeoutSource: 'profile',
  });
  const result = resolveLaunchOverrides(binding, 'n1', bindings);
  assert.ok(result !== undefined);
  assert.equal(result?.modelLevel, 'cheap');
  assert.equal(result?.timeoutMs, 30000);
});

test('resolveLaunchOverrides: later nodeId profile binding wins', () => {
  const bindings: BindingOverride[] = [
    { match: { nodeId: 'n1' }, runnerId: 'codex', modelLevel: 'codex-standard' },
    { match: { nodeId: 'n1' }, runnerId: 'claude-code', modelLevel: 'deep' },
  ];
  const result = resolveLaunchOverrides(makeBinding(), 'n1', bindings);

  assert.equal(result?.runnerId, 'claude-code');
  assert.equal(result?.modelLevel, 'deep');
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
