import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexService } from './codex.service.js';
import { RunService } from '../revisium/run.service.js';
import type { ControlPlaneTransport, TransportRow } from '../control-plane/data-access.js';
import type { ExecResult, ProcessExecutor } from '../worker/process-executor.js';

function makeFakeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' };
}

function makeDraftTransport(repoRef = '/tmp'): ControlPlaneTransport {
  return {
    mode: 'draft' as const,
    async assertReady() {},
    async listRows(table): Promise<{ edges: Array<{ node: TransportRow }> }> {
      if (table === 'task_runs') return { edges: [{ node: makeFakeRow('run-1', { repos: [repoRef] }) }] };
      if (table === 'tasks') return { edges: [{ node: makeFakeRow('task-1', { run_id: 'run-1', repo_ref: repoRef }) }] };
      return { edges: [] };
    },
    async getRow(table, rowId): Promise<TransportRow> {
      if (table === 'tasks') return makeFakeRow(rowId, { repo_ref: repoRef });
      return makeFakeRow(rowId, {});
    },
    async createRow(_table, rowId, data): Promise<TransportRow> {
      return makeFakeRow(rowId, data as Record<string, unknown>);
    },
    async updateRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
    async patchRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
  };
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

  const svc = new CodexService(fakeExecutor, new RunService(makeDraftTransport('/tmp')));

  const result = await svc.run({
    role: {
      name: 'developer',
      systemPrompt: 'You are developer',
      modelLevel: 'standard',
      effort: 'high',
      runner: 'codex',
      allowedTools: ['Read'],
      scopeRules: {},
      rights: 'read-only',
    },
    profile: {
      level: 'standard',
      provider: 'openai',
      modelId: 'gpt-5.5',
      params: {},
      costPerInput: 2,
      costPerOutput: 8,
    },
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
      modelProfile: 'standard',
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
  const svc = new CodexService(fakeExecutor, new RunService(makeDraftTransport()));
  const { run } = svc;
  assert.equal(typeof run, 'function');
});
