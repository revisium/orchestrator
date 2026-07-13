import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageCosts } from './runner-common.js';
import { normalizeNextSteps } from './result-envelope.js';
import { BASE_STEP } from './test-fixtures.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';

const binding = {
  runnerId: 'codex',
  provider: 'openai',
  modelId: 'gpt-5.6-luna',
  modelParams: {},
  slotKey: 'node:developer',
  nodeId: 'developer',
  roleId: 'developer',
  roleDocumentId: 'role-doc-developer',
  permissionMode: 'read-only',
  permissionSource: 'profile',
  runner: {
    runnerId: 'codex',
    manifestVersion: '1',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    stdoutParserId: 'codex-jsonl',
    permissionStyleId: 'codex-sandbox',
    declaredDefaultPermissionMode: 'read-only',
    capabilities: {},
    constraints: {},
    executionFields: {},
  },
} satisfies ResolvedAgentBinding;

test('next-step normalization removes model aliases instead of propagating them', () => {
  const next = normalizeNextSteps(
    [{ role: 'reviewer', kind: 'review', input: {}, modelProfile: 'legacy-alias' }],
    BASE_STEP,
  );

  assert.deepEqual(next[0], {
    taskId: BASE_STEP.taskId,
    role: 'reviewer',
    kind: 'review',
    input: {},
  });
  assert.equal(Object.hasOwn(next[0] ?? {}, 'modelProfile'), false);
});

test('usage conversion preserves reported zero and keeps unreported dimensions nullable', () => {
  assert.deepEqual(buildUsageCosts(binding, { inputTokens: 0 }), [{
    runnerId: 'codex',
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
    inputTokens: 0,
    outputTokens: null,
    costAmount: null,
    currency: null,
  }]);

  assert.deepEqual(buildUsageCosts(binding, { costUsd: 0 }), [{
    runnerId: 'codex',
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
    inputTokens: null,
    outputTokens: null,
    costAmount: 0,
    currency: 'USD',
  }]);

  assert.deepEqual(buildUsageCosts(binding, { currency: 'USD' }), []);
  assert.deepEqual(buildUsageCosts(binding, {}), []);
});
