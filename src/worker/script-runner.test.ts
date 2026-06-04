import test from 'node:test';
import assert from 'node:assert/strict';
import { createScriptRunner, type ScriptModule } from './script-runner.js';
import { createRunAgent } from './runner-dispatch.js';
import type { RunAgent, AttemptResult } from './runner.js';
import { makeRole, TEST_PROFILE, BASE_STEP } from './test-fixtures.js';

const SENTINEL: AttemptResult = { output: { ok: true }, nextSteps: [], costs: [], needsHuman: false };

function args(roleName: string) {
  return {
    role: makeRole(roleName, { runner: 'script' }),
    profile: TEST_PROFILE,
    context: 'ctx',
    attemptId: 'attempt-1',
    step: BASE_STEP,
  };
}

// ─── createScriptRunner ──────────────────────────────────────

test('createScriptRunner: calls registered script with parsed input and step', async () => {
  const calls: Array<{ input: unknown; step: unknown }> = [];
  const mod: ScriptModule = {
    async run(input, step) {
      calls.push({ input, step });
      return SENTINEL;
    },
  };

  const stepWithInput = { ...BASE_STEP, input: JSON.stringify({ pr_number: 42 }) };
  const runner = createScriptRunner({ scripts: { 'ci-poller': mod } });
  const result = await runner({
    role: makeRole('ci-poller', { runner: 'script' }),
    profile: TEST_PROFILE,
    context: 'ctx',
    attemptId: 'a1',
    step: stepWithInput,
  });

  assert.equal(result, SENTINEL);
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { input: unknown }).input, { pr_number: 42 });
  assert.equal((calls[0] as { step: unknown }).step, stepWithInput);
});

test('createScriptRunner: handles object input (already parsed)', async () => {
  const calls: Array<{ input: unknown }> = [];
  const mod: ScriptModule = {
    async run(input) {
      calls.push({ input });
      return SENTINEL;
    },
  };

  const stepWithObjInput = { ...BASE_STEP, input: { poll_count: 1 } };
  const runner = createScriptRunner({ scripts: { 'ci-poller': mod } });
  await runner({
    role: makeRole('ci-poller', { runner: 'script' }),
    profile: TEST_PROFILE,
    context: 'ctx',
    attemptId: 'a1',
    step: stepWithObjInput,
  });

  assert.deepEqual(calls[0].input, { poll_count: 1 });
});

test('createScriptRunner: handles null/empty input as empty object', async () => {
  const calls: Array<{ input: unknown }> = [];
  const mod: ScriptModule = {
    async run(input) {
      calls.push({ input });
      return SENTINEL;
    },
  };

  const stepWithNullInput = { ...BASE_STEP, input: null };
  const runner = createScriptRunner({ scripts: { 'ci-poller': mod } });
  await runner({
    role: makeRole('ci-poller', { runner: 'script' }),
    profile: TEST_PROFILE,
    context: 'ctx',
    attemptId: 'a1',
    step: stepWithNullInput,
  });

  assert.deepEqual(calls[0].input, {});
});

test('createScriptRunner: unregistered role throws SCRIPT_NOT_FOUND', async () => {
  const runner = createScriptRunner({ scripts: {} });

  await assert.rejects(
    () => runner(args('unknown-role')),
    /SCRIPT_NOT_FOUND: no script registered for role "unknown-role"/,
  );
});

test('createScriptRunner: timeout rejects with message naming the duration', async () => {
  const mod: ScriptModule = {
    run: () => new Promise(() => { /* never resolves */ }),
  };

  const runner = createScriptRunner({ scripts: { 'ci-poller': mod }, timeoutMs: 10 });

  await assert.rejects(
    () => runner(args('ci-poller')),
    /exceeded 10ms/,
  );
});

test('createScriptRunner: clears its timeout timer on success (no leaked event-loop timer)', async () => {
  // Without the finally/clearTimeout, the pending timer keeps the event loop alive until it
  // fires (~120s by default) and hangs `--once` and the test process. Spy on the global timers
  // to prove the runner clears the timer it scheduled once the script resolves.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const cleared: Array<ReturnType<typeof setTimeout>> = [];
  let created: ReturnType<typeof setTimeout> | undefined;

  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    created = realSetTimeout(fn, ms);
    return created;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    cleared.push(id);
    realClearTimeout(id);
  }) as unknown as typeof globalThis.clearTimeout;

  try {
    const mod: ScriptModule = { async run() { return SENTINEL; } };
    const runner = createScriptRunner({ scripts: { 'ci-poller': mod } });
    const result = await runner(args('ci-poller'));

    assert.equal(result, SENTINEL);
    assert.ok(created !== undefined, 'the timeout timer must be scheduled');
    assert.ok(cleared.includes(created!), 'the timeout timer must be cleared after resolution');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// ─── createRunAgent dispatch ─────────────────────────────────

test('createRunAgent: script with deps.script wired delegates correctly', async () => {
  const scriptResult: AttemptResult = { output: { from: 'script' }, nextSteps: [], costs: [] };
  const script: RunAgent = async () => scriptResult;
  const claudeCode: RunAgent = async () => SENTINEL;

  const runAgent = createRunAgent({ claudeCode, script });
  const result = await runAgent(args('ci-poller'));

  assert.equal(result, scriptResult);
});

test('createRunAgent: script without deps.script throws RUNNER_NOT_IMPLEMENTED', async () => {
  const claudeCode: RunAgent = async () => SENTINEL;
  const runAgent = createRunAgent({ claudeCode });

  await assert.rejects(
    () => runAgent(args('ci-poller')),
    /RUNNER_NOT_IMPLEMENTED: script runner not wired/,
  );
});
