import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunAgent } from './runner-dispatch.js';
import type { RunAgent, AttemptResult } from './runner.js';
import type { Role } from '../control-plane/definitions.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';
import { makeRole, BASE_STEP } from './test-fixtures.js';

const SENTINEL: AttemptResult = { output: { ran: 'claude-code' }, nextSteps: [], costs: [], needsHuman: false };

function binding(runnerId: string): ResolvedAgentBinding {
  return {
    runnerId,
    provider: runnerId === 'codex' ? 'openai' : 'anthropic',
    modelId: 'test-model',
    modelParams: {},
    slotKey: 'node:test',
    nodeId: 'test',
    roleId: 'test',
    roleDocumentId: 'role-doc-test',
    permissionMode: runnerId === 'codex' ? 'read-only' : 'default',
    permissionSource: 'profile',
    runner: {
      runnerId,
      manifestVersion: '1',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      stdoutParserId: `${runnerId}-json`,
      permissionStyleId: `${runnerId}-permission`,
      declaredDefaultPermissionMode: runnerId === 'codex' ? 'read-only' : 'default',
      capabilities: {},
      constraints: {},
      executionFields: {},
    },
  };
}

function callArgs(role: Role, runnerId: string) {
  return { role, binding: binding(runnerId), context: 'ctx', attemptId: 'attempt-1', step: BASE_STEP };
}

test('createRunAgent: delegates claude-code to the injected runner', async () => {
  const seen: Role[] = [];
  const claudeCode: RunAgent = async (args) => {
    seen.push(args.role);
    return SENTINEL;
  };

  const runAgent = createRunAgent({ claudeCode });
  const result = await runAgent(callArgs(makeRole('architect'), 'claude-code'));

  assert.equal(result, SENTINEL, 'returns exactly what the injected runner returns');
  assert.equal(seen.length, 1, 'claude-code runner invoked once');
});

test('createRunAgent: codex throws RUNNER_NOT_IMPLEMENTED when not wired', async () => {
  const claudeCode: RunAgent = async () => SENTINEL;
  const runAgent = createRunAgent({ claudeCode });

  await assert.rejects(
    () => runAgent(callArgs(makeRole('developer'), 'codex')),
    /RUNNER_NOT_IMPLEMENTED: codex runner not wired/,
  );
});

test('createRunAgent: delegates codex to the injected runner', async () => {
  const codexResult: AttemptResult = { output: { ran: 'codex' }, nextSteps: [], costs: [], needsHuman: false };
  const seen: Role[] = [];
  const claudeCode: RunAgent = async () => SENTINEL;
  const codex: RunAgent = async (args) => {
    seen.push(args.role);
    return codexResult;
  };

  const runAgent = createRunAgent({ claudeCode, codex });
  const result = await runAgent(callArgs(makeRole('developer'), 'codex'));

  assert.equal(result, codexResult, 'returns exactly what the injected codex runner returns');
  assert.equal(seen.length, 1, 'codex runner invoked once');
});

test('createRunAgent: an unknown runner throws RUNNER_NOT_IMPLEMENTED', async () => {
  const claudeCode: RunAgent = async () => SENTINEL;
  const runAgent = createRunAgent({ claudeCode });

  // Runtime data could carry a runner outside the type union; the defensive default must catch it.
  await assert.rejects(
    () => runAgent(callArgs(makeRole('developer'), 'weird')),
    /RUNNER_NOT_IMPLEMENTED: unknown runner "weird"/,
  );
});
