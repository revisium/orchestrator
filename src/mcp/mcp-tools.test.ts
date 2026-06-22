import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRevoMcpTools } from './mcp-tools.js';
import type { McpFacadeService } from './mcp-facade.service.js';

type RegisteredTool = {
  name: string;
  config: { inputSchema?: Record<string, unknown> };
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
