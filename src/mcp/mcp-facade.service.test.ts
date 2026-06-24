import test from 'node:test';
import assert from 'node:assert/strict';
import { McpFacadeService } from './mcp-facade.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';
import type { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { AgentObservabilityError } from '../observability/types.js';
import { CreateRunWorkflowError } from '../run/create-run.js';
import { RunWatchService } from '../task-control-plane/run-watch.service.js';

test('McpFacadeService.getCapabilities exposes the MCP transport surface', () => {
  const facade = new McpFacadeService({} as TaskControlPlaneApiService);
  const capabilities = facade.getCapabilities();

  assert.equal(capabilities.transport, 'stdio');
  assert.equal(capabilities.auth, 'none');
  assert.deepEqual(capabilities.tools, [...MCP_TOOL_NAMES]);
  assert.ok(capabilities.tools.includes('create_run'));
  assert.ok(capabilities.tools.includes('approve_gate'));
  assert.ok(capabilities.tools.includes('simulate_route'));
  assert.ok(capabilities.tools.includes('get_pr_readiness'));
  assert.ok(capabilities.tools.includes('list_pr_feedback'));
  assert.ok(capabilities.tools.includes('get_agent_activity'));
  assert.ok(capabilities.tools.includes('get_agent_attempts'));
  assert.ok(capabilities.tools.includes('get_agent_log'));
  assert.ok(capabilities.tools.includes('tail_agent_log'));
  assert.ok(capabilities.tools.includes('read_agent_output_events'));
  assert.ok(capabilities.tools.includes('wait_for_any_gate'));
  assert.ok(capabilities.tools.includes('watch_runs'));
});

test('McpFacadeService delegates the watch primitives to the injected RunWatchService', async () => {
  const api = {} as TaskControlPlaneApiService;
  const calls: Array<{ method: string; input: unknown }> = [];
  const runWatch = {
    async waitForAnyGate(input: unknown) {
      calls.push({ method: 'waitForAnyGate', input });
      return { transitions: [{ runId: 'r1', state: 'pending_gate', nextAction: 'approve' }], cursor: 'c1', timedOut: false };
    },
    async watchRuns(input: unknown) {
      calls.push({ method: 'watchRuns', input });
      return { transitions: [], cursor: 'c2', timedOut: true };
    },
  } as unknown as RunWatchService;
  const facade = new McpFacadeService(api, runWatch);

  const gateResult = await facade.waitForAnyGate({ runIds: ['r1'], timeoutMs: 1000 });
  const watchResult = await facade.watchRuns({ cursor: 'c1' });

  assert.deepEqual(calls[0], { method: 'waitForAnyGate', input: { runIds: ['r1'], timeoutMs: 1000 } });
  assert.deepEqual(calls[1], { method: 'watchRuns', input: { cursor: 'c1' } });
  assert.equal(gateResult.transitions[0]?.runId, 'r1');
  assert.equal(watchResult.timedOut, true);
});

test('McpFacadeService lazily builds a poll-fallback watch when none is injected', async () => {
  // Construct the facade the e2e/stdio path does (api only); the watch must still work over the api.
  const api = {
    async resolveRunState(runId: string) {
      return { runId, state: 'pending_gate', nextAction: 'approve', runStatus: 'running', workflowStatus: 'PENDING', inbox: { id: 'ix' } };
    },
    async listRuns() {
      return [];
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.waitForAnyGate({ runIds: ['r1'], timeoutMs: 0 });

  assert.equal(result.transitions[0]?.runId, 'r1');
  assert.equal(result.transitions[0]?.inbox?.id, 'ix');
});

test('McpFacadeService delegates product operations to TaskControlPlaneApiService', async () => {
  let received: unknown;
  const api = {
    async createRun(input: unknown) {
      received = input;
      return { runId: 'run-1', started: false };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  const result = await facade.createRun({ title: 'Task', repo: '.', start: false });

  assert.deepEqual(received, { title: 'Task', repo: '.', start: false });
  assert.deepEqual(result, { runId: 'run-1', started: false });
});

test('McpFacadeService.createRun exposes workflow row failure cause for MCP debugging', async () => {
  const api = {
    async createRun() {
      throw new CreateRunWorkflowError(
        'Failed to create run workflow rows',
        { runId: 'run-1' },
        new ControlPlaneError('VALIDATION_FAILURE', 'Validation failure: task_runs/run-1', { status: 422 }),
      );
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  await assert.rejects(
    () => facade.createRun({ title: 'Task', repo: '.', start: false }),
    /Failed to create run workflow rows: VALIDATION_FAILURE status=422: Validation failure: task_runs\/run-1; createdBeforeFailure=\{"runId":"run-1"\}/,
  );
});

test('McpFacadeService delegates PR readiness tools to TaskControlPlaneApiService', async () => {
  const calls: string[] = [];
  const api = {
    async getPrReadiness() {
      calls.push('getPrReadiness');
      return { verdict: 'ready' };
    },
    async listPrFeedback() {
      calls.push('listPrFeedback');
      return { developerFixes: [] };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.deepEqual(await facade.getPrReadiness({ repo: 'owner/repo', prNumber: 1 }), { verdict: 'ready' });
  assert.deepEqual(await facade.listPrFeedback({ repo: 'owner/repo', prNumber: 1 }), { developerFixes: [] });
  assert.deepEqual(calls, ['getPrReadiness', 'listPrFeedback']);
});

test('McpFacadeService delegates agent observability tools to TaskControlPlaneApiService', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const api = {
    async getAgentActivity(input: unknown) {
      calls.push({ name: 'getAgentActivity', input });
      return { runId: input, aggregateStatus: 'running' };
    },
    async getAgentAttempts(input: unknown) {
      calls.push({ name: 'getAgentAttempts', input });
      return [];
    },
    async getAgentLog(input: unknown) {
      calls.push({ name: 'getAgentLog', input });
      return { runId: 'run-1', attemptId: 'attempt-1', stream: 'combined', offsetBytes: 0, truncated: false, content: '' };
    },
    async readAgentOutputEvents(input: unknown) {
      calls.push({ name: 'readAgentOutputEvents', input });
      return { runId: 'run-1', events: [], cursorExpired: false };
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  assert.deepEqual(await facade.getAgentActivity('run-1'), { runId: 'run-1', aggregateStatus: 'running' });
  assert.deepEqual(await facade.getAgentAttempts('run-1'), []);
  assert.equal((await facade.getAgentLog({ runId: 'run-1', stream: 'combined', tailBytes: 65_536 })).stream, 'combined');
  assert.deepEqual(await facade.tailAgentLog({ runId: 'run-1', limit: 100, timeoutMs: 250 }), { runId: 'run-1', events: [], cursorExpired: false });
  assert.deepEqual(await facade.readAgentOutputEvents({ runId: 'run-1', cursor: 'c1', limit: 1 }), { runId: 'run-1', events: [], cursorExpired: false });
  assert.deepEqual(calls, [
    { name: 'getAgentActivity', input: 'run-1' },
    { name: 'getAgentAttempts', input: 'run-1' },
    { name: 'getAgentLog', input: { runId: 'run-1', stream: 'combined', tailBytes: 65_536 } },
    { name: 'readAgentOutputEvents', input: { runId: 'run-1', limit: 100, timeoutMs: 250 } },
    { name: 'readAgentOutputEvents', input: { runId: 'run-1', cursor: 'c1', limit: 1 } },
  ]);
});

test('McpFacadeService exposes agent observability application error codes', async () => {
  const api = {
    async getAgentLog() {
      throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
    },
    async readAgentOutputEvents() {
      throw new AgentObservabilityError('RUN_NOT_FOUND', 'run was not found');
    },
  } as unknown as TaskControlPlaneApiService;
  const facade = new McpFacadeService(api);

  await assert.rejects(
    () => facade.getAgentLog({ runId: 'missing', stream: 'combined' }),
    /RUN_NOT_FOUND: run was not found/,
  );
  await assert.rejects(
    () => facade.tailAgentLog({ runId: 'missing', timeoutMs: 1 }),
    /RUN_NOT_FOUND: run was not found/,
  );
  await assert.rejects(
    () => facade.readAgentOutputEvents({ runId: 'missing', timeoutMs: 1 }),
    /RUN_NOT_FOUND: run was not found/,
  );
});
