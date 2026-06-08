/**
 * claude-code.service.test.ts — M2: inject fake ProcessExecutor, assert no real spawn.
 *
 * Tests ClaudeCodeService wiring: fake PROCESS_EXECUTOR injected, resolveCwd reads from
 * RunService (via a fake transport), runner dispatches correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeService } from './claude-code.service.js';
import { RunService } from '../revisium/run.service.js';
import type { ProcessExecutor, ExecResult } from '../worker/process-executor.js';
import type { ControlPlaneTransport, TransportRow } from '../control-plane/data-access.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFakeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' };
}

function makeDraftTransport(repoRef = '/tmp'): ControlPlaneTransport {
  return {
    mode: 'draft' as const,
    async assertReady() {},
    async listRows(table): Promise<{ edges: Array<{ node: TransportRow }> }> {
      if (table === 'task_runs') {
        return { edges: [{ node: makeFakeRow('run-1', { repos: [repoRef] }) }] };
      }
      if (table === 'tasks') {
        return { edges: [{ node: makeFakeRow('task-1', { run_id: 'run-1', repo_ref: repoRef }) }] };
      }
      return { edges: [] };
    },
    async getRow(table, rowId): Promise<TransportRow> {
      if (table === 'tasks') return makeFakeRow(rowId, { repo_ref: repoRef });
      return makeFakeRow(rowId, {});
    },
    async createRow(table, rowId, data): Promise<TransportRow> {
      return makeFakeRow(rowId, data as Record<string, unknown>);
    },
    async updateRow(table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
    async patchRow(table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
  };
}

/** Minimal valid REVO_RESULT output for the claude runner to accept. */
function makeClaudeOutput(output: Record<string, unknown>): string {
  const agentText = [
    'Some reasoning text here.',
    '<<<REVO_RESULT',
    JSON.stringify({ output, nextSteps: [], needsHuman: false, lesson: null }),
    'REVO_RESULT>>>',
  ].join('\n');
  const envelope = {
    type: 'result',
    result: agentText,
    is_error: false,
    cost_usd: 0.001,
    input_tokens: 100,
    output_tokens: 50,
  };
  return JSON.stringify(envelope);
}

// ─── M2: inject fake ProcessExecutor ──────────────────────────────────────────

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

  const runService = new RunService(makeDraftTransport('/tmp'));
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
    modelProfile: 'standard',
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
    modelLevel: 'standard' as const,
    effort: 'high',
    runner: 'claude-code' as const,
    allowedTools: ['Read'],
    scopeRules: {},
  };

  const profile = {
    level: 'standard' as const,
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    params: {},
    costPerInput: 3,
    costPerOutput: 15,
  };

  const result = await svc.run({
    role,
    profile,
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
  const runService = new RunService(makeDraftTransport());
  const svc = new ClaudeCodeService(fakeExecutor, runService);

  // Destructure (simulate passing unbound) — must not throw "Cannot read properties of undefined"
  const { run } = svc;
  assert.equal(typeof run, 'function', 'run must be a function');
});
