import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeService } from './claude-code.service.js';
import { RunService } from '../revisium/run.service.js';
import type { ProcessExecutor, ExecResult } from '../worker/process-executor.js';
import { createInMemoryRuntimeDataAccess } from '../testing/runtime-data-access.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';

function makeRunService(repoRef = '/tmp'): RunService {
  return new RunService(createInMemoryRuntimeDataAccess({
    task_runs: {
      'run-1': { id: 'run-1', title: 'Run', status: 'ready', repos: [repoRef] },
    },
    tasks: {
      'task-1': { id: 'task-1', run_id: 'run-1', title: 'Task', status: 'ready', repo_ref: repoRef },
    },
  }).access);
}

function makeClaudeOutput(output: Record<string, unknown>): string {
  const envelope = {
    type: 'result',
    result: 'ignored prose',
    structured_output: { verdict: 'approved', output: JSON.stringify(output), needsHuman: false },
    is_error: false,
    cost_usd: 0.001,
    input_tokens: 100,
    output_tokens: 50,
  };
  return JSON.stringify(envelope);
}

test('M2: ClaudeCodeService uses injected fake ProcessExecutor — no real spawn', async () => {
  let spawnCalled = false;
  let capturedCwd = '';

  const fakeExecutor: ProcessExecutor = async (req): Promise<ExecResult> => {
    spawnCalled = true;
    capturedCwd = req.cwd;
    return {
      code: 0,
      stdout: makeClaudeOutput({ echo: 'test output' }),
      stderr: '',
      timedOut: false,
    };
  };

  const runService = makeRunService('/tmp');
  const svc = new ClaudeCodeService(fakeExecutor, runService);

  // Build minimal RunAgent args
  const { fnv1a64Hex } = await import('../control-plane/steps.js');
  const step = {
    id: 'pstep_test',
    taskId: 'task-1',
    runId: 'run-1',
    role: 'architect',
    kind: 'pipeline',
    status: 'running',
    input: {},
    output: null,
    runAfter: '',
    attemptCount: 0,
    maxAttempts: 1,
    priority: 0,
    leaseOwner: '',
    leaseExpiresAt: '',
    deadReason: '',
  };

  const role = {
    name: 'architect',
    systemPrompt: 'You are architect',
    allowedTools: ['Read'],
    scopeRules: {},
  };

  const binding: ResolvedAgentBinding = {
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
      runnerId: 'claude-code', manifestVersion: '1', manifestDigest: `sha256:${'a'.repeat(64)}`,
      stdoutParserId: 'claude-json', permissionStyleId: 'claude-permission-mode',
      declaredDefaultPermissionMode: 'default', capabilities: {}, constraints: {}, executionFields: {},
    },
  };

  const result = await svc.run({
    role,
    binding,
    context: 'test context',
    attemptId: `attempt_${fnv1a64Hex('run-1|architect')}`,
    step,
  });

  assert.equal(spawnCalled, true, 'fake executor must be called');
  assert.equal(capturedCwd, '/tmp', 'cwd must be resolved from tasks.repo_ref via RunService');
  assert.ok(result.output !== null, 'output must be present');
  assert.equal(result.costs.length, 1, 'costs must be extracted from transport envelope');
});

test('M2: ClaudeCodeService.run is an arrow property — safe to pass unbound', () => {
  const fakeExecutor: ProcessExecutor = async (_req) => ({ code: 0, stdout: '', stderr: '', timedOut: false });
  const runService = makeRunService();
  const svc = new ClaudeCodeService(fakeExecutor, runService);

  // Destructure (simulate passing unbound) — must not throw "Cannot read properties of undefined"
  const { run } = svc;
  assert.equal(typeof run, 'function', 'run must be a function');
});
