import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexService } from './codex.service.js';
import { RunService } from '../revisium/run.service.js';
import { createInMemoryRuntimeDataAccess } from '../testing/runtime-data-access.js';
import type { ExecResult, ProcessExecutor } from '../worker/process-executor.js';
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

function codexOutput(output: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: 'turn.completed',
    output: {
      verdict: 'approved',
      output: JSON.stringify(output),
      artifacts: null,
      nextSteps: [],
      needsHuman: false,
      lesson: null,
    },
  })}\n`;
}

test('CodexService uses injected fake ProcessExecutor and resolves cwd from RunService', async () => {
  let spawnCalled = false;
  let capturedCwd = '';
  let capturedCommand = '';

  const fakeExecutor: ProcessExecutor = async (req): Promise<ExecResult> => {
    spawnCalled = true;
    capturedCwd = req.cwd;
    capturedCommand = req.command;
    return { code: 0, stdout: codexOutput({ echo: 'test output' }), stderr: '', timedOut: false };
  };

  const svc = new CodexService(fakeExecutor, makeRunService('/tmp'));

  const result = await svc.run({
    role: {
      name: 'developer',
      systemPrompt: 'You are developer',
      allowedTools: ['Read'],
      scopeRules: {},
      rights: 'read-only',
    },
    binding: {
      runnerId: 'codex',
      provider: 'openai',
      modelId: 'gpt-5.5',
      modelParams: {},
      slotKey: 'node:developer',
      nodeId: 'developer',
      roleId: 'developer',
      roleDocumentId: 'role-doc-developer',
      permissionMode: 'workspace-write',
      permissionSource: 'profile',
      runner: {
        runnerId: 'codex', manifestVersion: '1', manifestDigest: `sha256:${'a'.repeat(64)}`,
        stdoutParserId: 'codex-jsonl', permissionStyleId: 'codex-sandbox',
        declaredDefaultPermissionMode: 'read-only', capabilities: {}, constraints: {}, executionFields: {},
      },
    } satisfies ResolvedAgentBinding,
    context: 'test context',
    attemptId: 'attempt_1',
    step: {
      id: 'step-1',
      taskId: 'task-1',
      runId: 'run-1',
      role: 'developer',
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
    },
  });

  assert.equal(spawnCalled, true, 'fake executor must be called');
  assert.equal(capturedCommand, 'codex');
  assert.equal(capturedCwd, '/tmp', 'cwd must be resolved from tasks.repo_ref via RunService');
  assert.equal(result.output, '{"echo":"test output"}');
});

test('CodexService.run is an arrow property and safe to pass unbound', () => {
  const fakeExecutor: ProcessExecutor = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });
  const svc = new CodexService(fakeExecutor, makeRunService());
  const { run } = svc;
  assert.equal(typeof run, 'function');
});
