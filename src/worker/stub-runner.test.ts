import test from 'node:test';
import assert from 'node:assert/strict';
import { stubRunAgent } from './stub-runner.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';

const PROFILE: ModelProfile = {
  level: 'standard',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  params: {},
  costPerInput: 3,
  costPerOutput: 15,
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
  modelProfile: 'standard',
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
    modelLevel: 'standard',
    effort: 'high',
    runner: 'claude-code',
    allowedTools: [],
    scopeRules: {},
  };
}

test('stubRunAgent: emits a passing verdict regardless of role (generic stub)', async () => {
  for (const role of ['architect', 'developer', 'reviewer', 'integrator', 'tester']) {
    const result = await stubRunAgent({
      role: makeRole(role),
      profile: PROFILE,
      context: 'some context',
      attemptId: 'attempt-1',
      step: { ...STEP, role },
    });

    assert.equal((result.output as Record<string, unknown>).verdict, 'PASS', `${role} → PASS`);
    assert.equal(result.nextSteps.length, 0, `${role} → no nextSteps (engine sequences from the template)`);
  }
});

test('stubRunAgent: returns zero costs', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: 'attempt-1',
    step: STEP,
  });

  assert.equal(result.costs.length, 0);
});

test('stubRunAgent: needsHuman is false', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: 'attempt-1',
    step: STEP,
  });

  assert.equal(result.needsHuman, false);
});

test('stubRunAgent: echo output includes role name and step id', async () => {
  const result = await stubRunAgent({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'abcde',
    attemptId: 'attempt-1',
    step: STEP,
  });

  const echo = (result.output as Record<string, string>).echo;
  assert.ok(echo.includes('role=architect'), 'output should contain role name');
  assert.ok(echo.includes(`step=${STEP.id}`), 'output should contain step id');
  assert.ok(echo.includes('contextSize=5'), 'output should contain context size');
});
