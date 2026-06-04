import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import type { ExecRequest, ExecResult, ProcessExecutor } from './process-executor.js';
import type { WorktreeManager } from './worktree-manager.js';
import { makeRole, BASE_STEP } from './test-fixtures.js';
import type { ModelProfile } from '../control-plane/definitions.js';

// Fake executor: records the ExecRequest and returns a canned ExecResult. No real `claude`, no tokens.
function fakeExecutor(result: ExecResult, captured: ExecRequest[]): ProcessExecutor {
  return async (req) => {
    captured.push(req);
    return result;
  };
}

const PROFILE: ModelProfile = {
  level: 'standard',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  params: {},
  costPerInput: 3,
  costPerOutput: 15,
};

function ok(stdout: string, extra: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false, ...extra };
}

function transport(resultText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result: resultText,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...extra,
  });
}

function agentBlock(obj: unknown): string {
  return `Here is the result.\n<<<REVO_RESULT\n${JSON.stringify(obj)}\nREVO_RESULT>>>\n`;
}

const ATTEMPT_ID = 'attempt_20260101T000000000Z_abc12345';

function run(executor: ProcessExecutor, roleOverrides = {}) {
  const runner = createClaudeCodeRunner({
    executor,
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });
  return runner({
    role: makeRole('architect', roleOverrides),
    profile: PROFILE,
    context: '## Role: architect\nDo the thing.',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
}

// ─── command build ────────────────────────────────────────────────────────────

test('claude-code runner: builds the documented claude -p invocation', async () => {
  const captured: ExecRequest[] = [];
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  await run(fakeExecutor(ok(stdout), captured));

  const req = captured[0];
  assert.ok(req, 'executor must be called once');
  assert.equal(req?.command, 'claude');
  assert.ok(req?.args.includes('-p'), 'args include -p');
  assert.ok(req?.args.includes('--permission-mode'), 'args include --permission-mode');
  assert.deepEqual(
    req?.args.slice(req.args.indexOf('--model'), req.args.indexOf('--model') + 2),
    ['--model', 'claude-sonnet-4-6'],
    'args include --model <profile.modelId>',
  );
  assert.deepEqual(
    req?.args.slice(req.args.indexOf('--output-format'), req.args.indexOf('--output-format') + 2),
    ['--output-format', 'json'],
    'args include --output-format json',
  );
  assert.equal(req?.cwd, '/workspace/repo', 'cwd comes from resolveCwd');
  assert.ok(req?.input?.includes(ATTEMPT_ID), 'prompt delivered on stdin includes the attemptId');
});

test('claude-code runner: no allowed-tools flag when role.allowedTools is empty', async () => {
  const captured: ExecRequest[] = [];
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  await run(fakeExecutor(ok(stdout), captured), { allowedTools: [] });

  assert.ok(!captured[0]?.args.includes('--allowedTools'), 'empty allowedTools → no tools flag');
});

test('claude-code runner: maps role.allowedTools to the allowed-tools flag', async () => {
  const captured: ExecRequest[] = [];
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  await run(fakeExecutor(ok(stdout), captured), { allowedTools: ['Edit', 'Write'] });

  const req = captured[0];
  const idx = req?.args.indexOf('--allowedTools') ?? -1;
  assert.ok(idx >= 0, 'allowed-tools flag present');
  assert.equal(req?.args[idx + 1], 'Edit,Write', 'tools joined and never widened beyond the list');
});

// ─── prompt contains the contract (regression guard) ──────────────────────────

test('claude-code runner: appends REVO_RESULT_CONTRACT to every prompt', async () => {
  const captured: ExecRequest[] = [];
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  await run(fakeExecutor(ok(stdout), captured));

  const input = captured[0]?.input ?? '';
  assert.ok(input.includes('<<<REVO_RESULT'), 'prompt must contain the open marker');
  assert.ok(input.includes('REVO_RESULT>>>'), 'prompt must contain the close marker');
});

// ─── envelope parse → AttemptResult ───────────────────────────────────────────

test('claude-code runner: parses the envelope into output/artifacts/nextSteps/costs', async () => {
  const stdout = transport(
    agentBlock({
      output: { summary: 'planned' },
      artifacts: { planPath: 'docs/plans/0099.md' },
      nextSteps: [{ role: 'developer', kind: 'implement', input: { from: 'step-1' } }],
      needsHuman: false,
      lesson: null,
    }),
  );

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.deepEqual(result.output, { summary: 'planned' });
  assert.deepEqual(result.artifacts, { planPath: 'docs/plans/0099.md' });
  assert.equal(result.nextSteps.length, 1);
  assert.equal(result.nextSteps[0]?.role, 'developer');
  assert.equal(result.nextSteps[0]?.taskId, BASE_STEP.taskId, 'taskId defaulted from step');
  assert.equal(result.needsHuman, false);
  assert.equal(result.costs.length, 1);
  assert.equal(result.costs[0]?.costAmount, 0.01, 'prefers CLI-reported USD');
  assert.equal(result.costs[0]?.inputTokens, 100);
  assert.equal(result.costs[0]?.modelProfile, BASE_STEP.modelProfile);
});

test('claude-code runner: reported total_cost_usd of 0 with non-zero tokens yields cost 0 (not token-computed)', async () => {
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }), {
    total_cost_usd: 0,
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.costs.length, 1, 'a reported $0 with tokens → one cost record');
  assert.equal(result.costs[0]?.costAmount, 0, 'reported $0 is honored, not overridden by token-computed amount');
});

test('claude-code runner: computes cost from tokens when no USD is reported', async () => {
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }), {
    total_cost_usd: undefined,
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  // 1e6/1e6*3 + 1e6/1e6*15 = 18
  assert.equal(result.costs[0]?.costAmount, 18);
});

test('claude-code runner: zero tokens and no USD → empty costs', async () => {
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }), {
    total_cost_usd: undefined,
    usage: { input_tokens: 0, output_tokens: 0 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.costs.length, 0);
});

// ─── timeout ──────────────────────────────────────────────────────────────────

test('claude-code runner: throws on timeout (mentions the timeout)', async () => {
  await assert.rejects(
    () => run(fakeExecutor({ code: null, stdout: '', stderr: '', timedOut: true }, [])),
    /exceeded 5000ms/,
  );
});

// ─── error → lesson ─────────────────────────────────────────────────────────

test('claude-code runner: non-zero exit throws with stderr as the lesson', async () => {
  await assert.rejects(
    () => run(fakeExecutor({ code: 1, stdout: '', stderr: 'auth required', timedOut: false }, [])),
    /auth required/,
  );
});

test('claude-code runner: is_error transport throws with the text as the lesson', async () => {
  const stdout = JSON.stringify({ is_error: true, result: 'model refused' });
  await assert.rejects(
    () => run(fakeExecutor(ok(stdout), [])),
    /model refused/,
  );
});

test('claude-code runner: non-JSON stdout throws the transport lesson', async () => {
  await assert.rejects(
    () => run(fakeExecutor(ok('this is not json'), [])),
    /transport envelope/,
  );
});

test('claude-code runner: missing REVO_RESULT block throws the agent-envelope lesson', async () => {
  const stdout = transport('I did the work but forgot the block.');
  await assert.rejects(
    () => run(fakeExecutor(ok(stdout), [])),
    /agent did not emit a parseable REVO_RESULT envelope/,
  );
});

// ─── needsHuman ────────────────────────────────────────────────────────────

test('claude-code runner: needsHuman returns true and drops nextSteps', async () => {
  const stdout = transport(
    agentBlock({
      output: { question: 'approve?' },
      // agent erroneously included a nextStep — runner must drop it on needsHuman
      nextSteps: [{ role: 'developer', kind: 'implement', input: null }],
      needsHuman: true,
      lesson: 'blocked on approval',
    }),
  );

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0, 'needsHuman drops nextSteps');
  assert.equal(result.lesson, 'blocked on approval');
});

// ─── idempotency / no external calls beyond the executor ──────────────────────

test('claude-code runner: threads attemptId into the prompt and calls only the executor', async () => {
  const captured: ExecRequest[] = [];
  let resolveCwdCalls = 0;
  let executorCalls = 0;
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));

  const runner = createClaudeCodeRunner({
    executor: async (req) => {
      executorCalls++;
      captured.push(req);
      return ok(stdout);
    },
    resolveCwd: async () => {
      resolveCwdCalls++;
      return '/workspace/x';
    },
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });

  assert.ok(captured[0]?.input?.includes(ATTEMPT_ID), 'attemptId present in delivered prompt');
  assert.equal(executorCalls, 1, 'process launched exactly once via the executor');
  assert.equal(resolveCwdCalls, 1, 'no external call beyond executor + injected resolveCwd');
});

// ─── defaults ──────────────────────────────────────────────────────────────

test('claude-code runner: defaults command to "claude"', async () => {
  const captured: ExecRequest[] = [];
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  await run(fakeExecutor(ok(stdout), captured));
  assert.equal(captured[0]?.command, 'claude');
});

// ─── worktree lifecycle ───────────────────────────────────────────────────────

test('claude-code runner: creates and releases an injected worktree around executor cwd', async () => {
  const captured: ExecRequest[] = [];
  const createCalls: Array<{ stepId: string; baseDir: string }> = [];
  const releaseCalls: string[] = [];
  const manager: WorktreeManager = {
    async create(stepId, baseDir) {
      createCalls.push({ stepId, baseDir });
      return '/workspace/repo/.worktrees/step-1';
    },
    async release(worktreePath) {
      releaseCalls.push(worktreePath);
    },
  };
  const stdout = transport(agentBlock({ output: 'ok', nextSteps: [], needsHuman: false }));
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), captured),
    resolveCwd: async () => '/workspace/repo',
    worktreeManager: manager,
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });

  assert.deepEqual(createCalls, [{ stepId: BASE_STEP.id, baseDir: '/workspace/repo' }]);
  assert.equal(captured[0]?.cwd, '/workspace/repo/.worktrees/step-1');
  assert.deepEqual(releaseCalls, ['/workspace/repo/.worktrees/step-1']);
});

test('claude-code runner: propagates worktree create errors without release', async () => {
  const releaseCalls: string[] = [];
  const manager: WorktreeManager = {
    async create() {
      throw new Error('worktree create failed');
    },
    async release(worktreePath) {
      releaseCalls.push(worktreePath);
    },
  };
  const runner = createClaudeCodeRunner({
    executor: async () => ok('unreachable'),
    resolveCwd: async () => '/workspace/repo',
    worktreeManager: manager,
    timeoutMs: 5_000,
  });

  await assert.rejects(
    () => runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
    }),
    /worktree create failed/,
  );
  assert.deepEqual(releaseCalls, []);
});

test('claude-code runner: releases worktree when result parsing throws', async () => {
  const releaseCalls: string[] = [];
  const manager: WorktreeManager = {
    async create() {
      return '/workspace/repo/.worktrees/parse-error';
    },
    async release(worktreePath) {
      releaseCalls.push(worktreePath);
    },
  };
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok('this is not json'), []),
    resolveCwd: async () => '/workspace/repo',
    worktreeManager: manager,
    timeoutMs: 5_000,
  });

  await assert.rejects(
    () => runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
    }),
    /transport envelope/,
  );
  assert.deepEqual(releaseCalls, ['/workspace/repo/.worktrees/parse-error']);
});

test('claude-code runner: release failure does not mask a successful AttemptResult', async () => {
  const manager: WorktreeManager = {
    async create() {
      return '/workspace/repo/.worktrees/step-release-fail';
    },
    async release() {
      throw new Error('release failed');
    },
  };
  const stdout = transport(agentBlock({ output: 'done', nextSteps: [], needsHuman: false }));
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    worktreeManager: manager,
    timeoutMs: 5_000,
  });

  const result = await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });

  assert.equal(result.output, 'done', 'success AttemptResult is returned despite release failure');
  assert.equal(result.needsHuman, false);
});
