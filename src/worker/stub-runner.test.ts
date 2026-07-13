import test from 'node:test';
import assert from 'node:assert/strict';
import { stubRunAgent } from './stub-runner.js';
import type { Role } from '../control-plane/definitions.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';
import type { Step } from '../control-plane/steps.js';

const BINDING: ResolvedAgentBinding = {
  runnerId: 'claude-code',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  modelParams: {},
  slotKey: 'node:architect',
  nodeId: 'architect',
  roleId: 'architect',
  roleDocumentId: 'role-doc-architect',
  permissionMode: 'default',
  permissionSource: 'profile',
  runner: {
    runnerId: 'claude-code',
    manifestVersion: '1',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    stdoutParserId: 'claude-json',
    permissionStyleId: 'claude-permission-mode',
    declaredDefaultPermissionMode: 'default',
    capabilities: {},
    constraints: {},
    executionFields: {},
  },
};

const STEP: Step = {
  id: 'step-arch-1',
  taskId: 'task-1',
  runId: 'run-1',
  role: 'architect',
  kind: 'plan_run',
  status: 'running',
  input: { title: 'Build X' },
  output: null,
  runAfter: '',
  attemptCount: 1,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: 'worker-1',
  leaseExpiresAt: '',
  deadReason: '',
};

function makeRole(name: string): Role {
  return {
    name,
    systemPrompt: `You are the ${name}.`,
    allowedTools: [],
    scopeRules: {},
  };
}

test('stubRunAgent: emits a top-level passing verdict regardless of role (generic stub)', async () => {
  for (const role of ['architect', 'developer', 'reviewer', 'integrator', 'tester']) {
    const result = await stubRunAgent({
      role: makeRole(role),
      binding: BINDING,
      context: 'some context',
      attemptId: 'attempt-1',
      step: { ...STEP, role },
    });

    assert.equal(result.verdict, 'approved', `${role} -> approved`);
    assert.equal((result.output as Record<string, unknown>).verdict, undefined, `${role} -> no output verdict`);
    assert.equal(result.nextSteps.length, 0, `${role} → no nextSteps (engine sequences from the template)`);
  }
});

test('stubRunAgent: returns zero costs', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    binding: BINDING,
    context: 'ctx',
    attemptId: 'attempt-1',
    step: STEP,
  });

  assert.equal(result.costs.length, 0);
});

test('stubRunAgent: needsHuman is false', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    binding: BINDING,
    context: 'ctx',
    attemptId: 'attempt-1',
    step: STEP,
  });

  assert.equal(result.needsHuman, false);
});

test('stubRunAgent: echo output includes role name and step id', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    binding: BINDING,
    context: 'abcde',
    attemptId: 'attempt-1',
    step: STEP,
  });

  const echo = (result.output as Record<string, string>).echo;
  assert.ok(echo.includes('role=architect'), 'output should contain role name');
  assert.ok(echo.includes(`step=${STEP.id}`), 'output should contain step id');
  assert.ok(echo.includes('contextSize=5'), 'output should contain context size');
});
