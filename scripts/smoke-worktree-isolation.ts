import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { GitWorktreeManager } from '../src/worker/git-worktree-manager.js';
import { createClaudeCodeRunner } from '../src/worker/claude-code-runner.js';
import type { ExecRequest, ExecResult, ProcessExecutor } from '../src/worker/process-executor.js';
import type { ModelProfile, Role } from '../src/control-plane/definitions.js';
import type { Step } from '../src/control-plane/steps.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function pass(message: string): void {
  console.log(`PASS ${message}`);
}

function transport(resultText: string): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result: resultText,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
}

function agentBlock(output: string): string {
  return `<<<REVO_RESULT\n${JSON.stringify({ output, nextSteps: [], needsHuman: false, lesson: null })}\nREVO_RESULT>>>\n`;
}

const repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
const manager = new GitWorktreeManager();
const role: Role = {
  name: 'developer',
  runner: 'claude-code',
  modelLevel: 'standard',
  systemPrompt: 'Smoke test role',
  allowedTools: [],
  scopeRules: {},
};
const profile: ModelProfile = {
  level: 'standard',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  params: {},
  costPerInput: 0,
  costPerOutput: 0,
};
const step: Step = {
  id: 'smoke-runner-worktree',
  taskId: 'smoke-task',
  runId: 'smoke-run',
  role: 'developer',
  kind: 'implement',
  status: 'claimed',
  input: null,
  output: null,
  modelProfile: 'standard',
  runAfter: '',
  attemptCount: 0,
  maxAttempts: 3,
  priority: 0,
  leaseOwner: '',
  leaseExpiresAt: '',
  deadReason: '',
};

const directStepId = `smoke-direct-${String(Date.now())}`;
const directPath = join(repoRoot, '.worktrees', directStepId);
try {
  const createdPath = await manager.create(directStepId, repoRoot);
  assert.equal(createdPath, directPath);
  assert.equal(git(['rev-parse', '--is-inside-work-tree'], createdPath), 'true');
  const nodeModulesPath = join(createdPath, 'node_modules');
  assert.equal((await lstat(nodeModulesPath)).isSymbolicLink(), true);
  assert.equal(await realpath(nodeModulesPath), join(repoRoot, 'node_modules'));
  pass('direct create produced a git worktree with node_modules symlink');
} finally {
  await manager.release(directPath);
}
assert.equal(existsSync(directPath), false);
assert.equal(git(['branch', '--list', `run/${directStepId}`], repoRoot), '');
pass('direct release removed the worktree and run branch');

const captured: ExecRequest[] = [];
const successExecutor: ProcessExecutor = async (req) => {
  captured.push(req);
  const result: ExecResult = {
    code: 0,
    stdout: transport(agentBlock('ok')),
    stderr: '',
    timedOut: false,
  };
  return result;
};
const runner = createClaudeCodeRunner({
  executor: successExecutor,
  resolveCwd: async () => repoRoot,
  worktreeManager: manager,
  timeoutMs: 5_000,
});
await runner({ role, profile, context: 'smoke context', attemptId: 'smoke-attempt-success', step });
const runnerCwd = captured[0]?.cwd;
assert.ok(runnerCwd?.startsWith(join(repoRoot, '.worktrees')));
assert.equal(existsSync(runnerCwd), false);
assert.equal(git(['branch', '--list', `run/${step.id}`], repoRoot), '');
pass('runner success used a .worktrees cwd and cleaned it up');

const parseErrorStep = { ...step, id: 'smoke-runner-parse-error' };
let parseErrorCwd = '';
const parseErrorRunner = createClaudeCodeRunner({
  executor: async (req) => {
    parseErrorCwd = req.cwd;
    return { code: 0, stdout: 'invalid json', stderr: '', timedOut: false };
  },
  resolveCwd: async () => repoRoot,
  worktreeManager: manager,
  timeoutMs: 5_000,
});
await assert.rejects(
  () => parseErrorRunner({
    role,
    profile,
    context: 'smoke context',
    attemptId: 'smoke-attempt-parse-error',
    step: parseErrorStep,
  }),
  /transport envelope/,
);
assert.ok(parseErrorCwd.startsWith(join(repoRoot, '.worktrees')));
assert.equal(existsSync(parseErrorCwd), false);
assert.equal(git(['branch', '--list', `run/${parseErrorStep.id}`], repoRoot), '');
pass('runner parse error still cleaned up the worktree and branch');
