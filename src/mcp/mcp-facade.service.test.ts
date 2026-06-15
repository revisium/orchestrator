import test from 'node:test';
import assert from 'node:assert/strict';
import { McpFacadeService } from './mcp-facade.service.js';
import { MCP_TOOL_NAMES } from './mcp-capabilities.js';
import type { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { CreateRunWorkflowError } from '../run/create-run.js';

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
