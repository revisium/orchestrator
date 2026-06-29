import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WATCH_CURSOR_CHARS } from '../task-control-plane/run-watch.service.js';
import { registerRevoMcpTools } from './mcp-tools.js';
import type { McpFacadeService } from './mcp-facade.service.js';

type RegisteredTool = {
  name: string;
  config: { description?: string; inputSchema?: Record<string, unknown> };
  handler: (input: never) => Promise<unknown> | unknown;
};

function makeServer() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) {
        tools.push({ name, config, handler });
      },
    },
  };
}

function parseToolText(result: unknown): unknown {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]?.text ?? 'null') as unknown;
}

test('registerRevoMcpTools registers agent observability tools', () => {
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('get_agent_activity'));
  assert.ok(names.includes('get_agent_attempts'));
  assert.ok(names.includes('get_agent_log'));
  assert.ok(names.includes('tail_agent_log'));
  assert.ok(names.includes('read_agent_output_events'));
  assert.equal(Boolean(tools.find((tool) => tool.name === 'get_agent_log')?.config.inputSchema?.stream), true);
});

test('observe_run is registered as the canonical low-context observation tool', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  const tool = tools.find((registered) => registered.name === 'observe_run');
  assert.ok(tool);
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ runId: 'r1' }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', mode: 'heartbeat', heartbeatEveryMs: 45_000 }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', mode: 'other' }).success, false);
  assert.equal(schema.safeParse({ runId: 'r1', timeoutMs: 45_001 }).success, false);
  assert.equal(schema.safeParse({ runId: 'r1', cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS) }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS + 1) }).success, false);
  assert.equal(tool.config.description?.includes('without raw logs or full events'), true);
});

test('create_run schema accepts issueRef traceability metadata', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  const tool = tools.find((registered) => registered.name === 'create_run');
  assert.ok(tool);
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  const issueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  assert.equal(schema.safeParse({ title: 'Task', repo: '.', start: false, issueRef }).success, true);
  assert.equal(schema.safeParse({ title: 'Task', repo: '.', start: false, issueRef: { ...issueRef, number: 0 } }).success, false);
});

test('create_run description mentions explicit pipelineId requirement and confirmationRequired', () => {
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((registered) => registered.name === 'create_run');
  assert.ok(tool);
  assert.ok(tool.config.description?.includes('explicit pipelineId'), 'description must mention explicit pipelineId');
  assert.ok(tool.config.description?.includes('confirmationRequired'), 'description must mention confirmationRequired');
});

test('create_run schema accepts both omitted and explicit pipelineId', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((registered) => registered.name === 'create_run');
  assert.ok(tool);
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ title: 'Task', repo: '.' }).success, true, 'pipelineId may be omitted');
  assert.equal(schema.safeParse({ title: 'Task', repo: '.', pipelineId: 'feature-development' }).success, true, 'explicit pipelineId accepted');
  assert.equal(schema.safeParse({ title: 'Task', repo: '.', pipelineId: '' }).success, false, 'empty pipelineId rejected by min(1)');
});

test('pipeline MCP tools expose compact defaults with explicit detail opt-in', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  const listTool = tools.find((registered) => registered.name === 'list_pipelines');
  const getTool = tools.find((registered) => registered.name === 'get_pipeline');
  assert.ok(listTool);
  assert.ok(getTool);
  const listSchema = z.object(listTool.config.inputSchema as Record<string, never>);
  const getSchema = z.object(getTool.config.inputSchema as Record<string, never>);
  assert.equal(listSchema.safeParse({}).success, true);
  assert.equal(listSchema.safeParse({ includeDetails: true }).success, true);
  assert.equal(getSchema.safeParse({ pipelineId: 'pipe-1' }).success, true);
  assert.equal(getSchema.safeParse({ pipelineId: 'pipe-1', includeDetails: true }).success, true);
  assert.equal(listTool.config.description?.includes('Compact by default'), true);
  assert.equal(getTool.config.description?.includes('Compact by default'), true);
});

test('observe_run handler forwards the request abort signal to the facade', async () => {
  const { server, tools } = makeServer();
  let received: { runId?: string; signal?: AbortSignal } | undefined;
  const facade = {
    async observeRun(input: { runId?: string; signal?: AbortSignal }) {
      received = input;
      return { runId: 'r1', cursor: 'c', state: 'running', timedOut: true, nextAction: 'wait' };
    },
  } as unknown as McpFacadeService;
  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'observe_run');
  assert.ok(tool);

  const ac = new AbortController();
  const invoke = tool.handler as unknown as (input: unknown, extra: unknown) => Promise<unknown>;
  const result = await invoke({ runId: 'r1' }, { signal: ac.signal });

  assert.deepEqual(parseToolText(result), { runId: 'r1', cursor: 'c', state: 'running', timedOut: true, nextAction: 'wait' });
  assert.deepEqual(received?.runId, 'r1');
  assert.equal(received?.signal, ac.signal);
});

test('get_agent_log MCP tool validates conflicting bounded read inputs before facade delegation', async () => {
  const { server, tools } = makeServer();
  const calls: unknown[] = [];
  const facade = {
    async getAgentLog(input: unknown) {
      calls.push(input);
      return { runId: 'run-1', attemptId: 'attempt-1', stream: 'combined', offsetBytes: 0, truncated: false, content: '' };
    },
  } as unknown as McpFacadeService;

  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'get_agent_log');
  assert.ok(tool);

  await assert.rejects(
    () => Promise.resolve(tool.handler({
      runId: 'run-1',
      stream: 'combined',
      offsetBytes: 0,
      tailBytes: 10,
    } as never)),
    /VALIDATION_FAILURE: tailBytes cannot be combined/,
  );
  assert.deepEqual(calls, []);

  const result = await tool.handler({ runId: 'run-1', stream: 'combined', tailBytes: 65_536 } as never);
  assert.equal((parseToolText(result) as { stream: string }).stream, 'combined');
  assert.deepEqual(calls, [{ runId: 'run-1', stream: 'combined', tailBytes: 65_536 }]);
});

test('wait_for_any_gate and watch_runs are registered with a hold cap ≤45s', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('wait_for_any_gate'));
  assert.ok(names.includes('watch_runs'));
  assert.ok(names.includes('observe_run'));

  // The cap is the binding fix: a wait above the inner-hop budget dies at the transport. Includes
  // wait_for_run, whose 120000 cap was lowered to 45000 in the same slice.
  for (const name of ['wait_for_run', 'wait_for_any_gate', 'watch_runs']) {
    const tool = tools.find((registered) => registered.name === name);
    assert.ok(tool, name);
    const schema = z.object(tool.config.inputSchema as Record<string, never>);
    assert.equal(schema.safeParse({ runId: 'r', runIds: ['r'], timeoutMs: 45_001 }).success, false, `${name} rejects >45s`);
    assert.equal(schema.safeParse({ runId: 'r', runIds: ['r'], timeoutMs: 45_000 }).success, true, `${name} accepts 45s`);
    if (name !== 'wait_for_run') {
      assert.equal(schema.safeParse({ runIds: ['r'], cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS) }).success, true, `${name} accepts max cursor`);
      assert.equal(schema.safeParse({ runIds: ['r'], cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS + 1) }).success, false, `${name} rejects oversized cursor`);
    }
  }
  const observeRun = tools.find((registered) => registered.name === 'observe_run');
  assert.ok(observeRun);
  const schema = z.object(observeRun.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ runId: 'r', timeoutMs: 45_001 }).success, false, 'observe_run rejects >45s');
  assert.equal(schema.safeParse({ runId: 'r', timeoutMs: 45_000 }).success, true, 'observe_run accepts 45s');
});

test('wait_for_any_gate handler forwards the request abort signal to the facade', async () => {
  const { server, tools } = makeServer();
  let received: { runIds?: string[]; signal?: AbortSignal } | undefined;
  const facade = {
    async waitForAnyGate(input: { runIds?: string[]; signal?: AbortSignal }) {
      received = input;
      return { transitions: [], cursor: 'c', timedOut: true };
    },
  } as unknown as McpFacadeService;
  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'wait_for_any_gate');
  assert.ok(tool);

  const ac = new AbortController();
  const invoke = tool.handler as unknown as (input: unknown, extra: unknown) => Promise<unknown>;
  await invoke({ runIds: ['r1'] }, { signal: ac.signal });

  assert.deepEqual(received?.runIds, ['r1']);
  assert.equal(received?.signal, ac.signal);
});

test('get_run_events: schema accepts expand:["graph"] and rejects unknown expand values', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((registered) => registered.name === 'get_run_events');
  assert.ok(tool, 'get_run_events tool registered');
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ runId: 'r' }).success, true, 'no expand is valid');
  assert.equal(schema.safeParse({ runId: 'r', expand: ['graph'] }).success, true, 'expand:["graph"] is valid');
  assert.equal(schema.safeParse({ runId: 'r', expand: ['unknown-value'] }).success, false, 'expand with unknown value is invalid');
});

test('get_run_events: handler forwards expand to facade', async () => {
  const { server, tools } = makeServer();
  let received: unknown;
  const facade = {
    async getRunEvents(input: unknown) {
      received = input;
      return [];
    },
  } as unknown as McpFacadeService;
  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'get_run_events');
  assert.ok(tool);

  await tool.handler({ runId: 'run-1', expand: ['graph'] } as never);

  assert.deepEqual((received as Record<string, unknown>)['expand'], ['graph']);
});
