import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunAgent } from './runner-dispatch.js';
import type { RunAgent, AttemptResult } from './runner.js';
import type { Role } from '../control-plane/definitions.js';
import { makeRole, TEST_PROFILE, BASE_STEP } from './test-fixtures.js';

const SENTINEL: AttemptResult = { output: { ran: 'claude-code' }, nextSteps: [], costs: [], needsHuman: false };

function callArgs(role: Role) {
  return { role, profile: TEST_PROFILE, context: 'ctx', attemptId: 'attempt-1', step: BASE_STEP };
}

test('createRunAgent: delegates claude-code to the injected runner', async () => {
  const seen: Role[] = [];
  const claudeCode: RunAgent = async (args) => {
    seen.push(args.role);
    return SENTINEL;
  };

  const runAgent = createRunAgent({ claudeCode });
  const result = await runAgent(callArgs(makeRole('architect', { runner: 'claude-code' })));

  assert.equal(result, SENTINEL, 'returns exactly what the injected runner returns');
  assert.equal(seen.length, 1, 'claude-code runner invoked once');
});

test('createRunAgent: codex throws RUNNER_NOT_IMPLEMENTED', async () => {
  const claudeCode: RunAgent = async () => SENTINEL;
  const runAgent = createRunAgent({ claudeCode });

  await assert.rejects(
    () => runAgent(callArgs(makeRole('developer', { runner: 'codex' }))),
    /RUNNER_NOT_IMPLEMENTED: codex/,
  );
});

test('createRunAgent: an unknown runner throws RUNNER_NOT_IMPLEMENTED', async () => {
  const claudeCode: RunAgent = async () => SENTINEL;
  const runAgent = createRunAgent({ claudeCode });

  // Runtime data could carry a runner outside the type union; the defensive default must catch it.
  const badRole = { ...makeRole('developer'), runner: 'weird' as unknown as Role['runner'] };
  await assert.rejects(
    () => runAgent(callArgs(badRole)),
    /RUNNER_NOT_IMPLEMENTED: unknown runner "weird"/,
  );
});
