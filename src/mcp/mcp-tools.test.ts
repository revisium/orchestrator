import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WATCH_CURSOR_CHARS } from '../task-control-plane/run-watch.service.js';
import { registerRevoMcpTools } from './mcp-tools.js';
import { OPERATOR_MONITORING_PROTOCOL, buildMonitoringDirective } from './monitoring-directive.js';
import { MCP_INSTRUCTIONS } from './mcp-capabilities.js';
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

test('get_run_attention and get_run_status are registered with runId-only schemas', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  for (const name of ['get_run_attention', 'get_run_status']) {
    const tool = tools.find((registered) => registered.name === name);
    assert.ok(tool, `${name} must be registered`);
    const schema = z.object(tool.config.inputSchema as Record<string, never>);
    assert.equal(schema.safeParse({ runId: 'r1' }).success, true, `${name} accepts runId`);
    assert.equal(schema.safeParse({}).success, false, `${name} rejects empty input`);
    assert.equal('cursor' in (tool.config.inputSchema ?? {}), false, `${name} must not accept cursor`);
    assert.equal('timeoutMs' in (tool.config.inputSchema ?? {}), false, `${name} must not accept timeoutMs`);
  }
});

test('watch_run_changes is registered with runId + optional cursor and timeoutMs ≤45s', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();

  registerRevoMcpTools(server as never, {} as McpFacadeService);

  const tool = tools.find((registered) => registered.name === 'watch_run_changes');
  assert.ok(tool, 'watch_run_changes must be registered');
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ runId: 'r1' }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', timeoutMs: 45_000 }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', timeoutMs: 45_001 }).success, false, 'rejects >45s');
  assert.equal(schema.safeParse({ runId: 'r1', cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS) }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', cursor: 'x'.repeat(MAX_WATCH_CURSOR_CHARS + 1) }).success, false, 'rejects oversized cursor');
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

test('watch_run_changes handler forwards the request abort signal to the facade', async () => {
  const { server, tools } = makeServer();
  let received: { runId?: string; signal?: AbortSignal } | undefined;
  const facade = {
    async watchRunChanges(input: { runId?: string; signal?: AbortSignal }) {
      received = input;
      return { transitions: [], cursor: 'c', timedOut: true };
    },
  } as unknown as McpFacadeService;
  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'watch_run_changes');
  assert.ok(tool);

  const ac = new AbortController();
  const invoke = tool.handler as unknown as (input: unknown, extra: unknown) => Promise<unknown>;
  const result = await invoke({ runId: 'r1' }, { signal: ac.signal });

  assert.deepEqual(parseToolText(result), { transitions: [], cursor: 'c', timedOut: true });
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

test('resolve_gate MCP schema and handler require adoption audit before facade delegation', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  const calls: unknown[] = [];
  const adoptionAudit = {
    runId: 'run-1',
    step: 'developer',
    role: 'developer-codex',
    artifactRef: 'attempt:attempt-1',
    targetRepo: '/repo',
    targetBranch: 'feature/x',
    actor: 'anton',
    scope: 'apply generated patch only',
    risk: 'manual patch adoption',
    verificationResponsibility: 'main session runs pnpm verify',
  };
  const facade = {
    async resolveGate(input: unknown) {
      calls.push(input);
      return { ok: true };
    },
  } as unknown as McpFacadeService;

  registerRevoMcpTools(server as never, facade);
  const tool = tools.find((registered) => registered.name === 'resolve_gate');
  assert.ok(tool);
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ inboxId: 'inbox-1', outcome: 'adopt_patch_manually', adoptionAudit }).success, true);
  assert.equal(
    schema.safeParse({ inboxId: 'inbox-1', outcome: 'adopt_patch_manually', adoptionAudit: { ...adoptionAudit, artifactRef: '' } }).success,
    false,
  );

  await assert.rejects(
    () => Promise.resolve(tool.handler({ inboxId: 'inbox-1', outcome: 'adopt_patch_manually' } as never)),
    /VALIDATION_FAILURE: adopt_patch_manually requires complete adoptionAudit/,
  );
  assert.deepEqual(calls, []);

  await tool.handler({ inboxId: 'inbox-1', outcome: 'adopt_patch_manually', adoptionAudit } as never);
  assert.deepEqual(calls, [{ inboxId: 'inbox-1', outcome: 'adopt_patch_manually', adoptionAudit }]);
});

test('get_run_attention description marks it as default/primary monitoring tool and answers "what currently requires attention?"', () => {
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((registered) => registered.name === 'get_run_attention');
  assert.ok(tool);
  assert.ok(
    tool.config.description?.toLowerCase().includes('default') || tool.config.description?.toLowerCase().includes('primary'),
    'description must mention default or primary',
  );
  assert.ok(tool.config.description?.includes('what currently requires attention'), 'description must include "what currently requires attention"');
});

test('watch_run_changes description states it is not for normal task monitoring and is a change-stream/cursor tool', () => {
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((registered) => registered.name === 'watch_run_changes');
  assert.ok(tool);
  assert.ok(tool.config.description?.toLowerCase().includes('not for normal task monitoring'), 'description must say "not for normal task monitoring"');
  assert.ok(
    tool.config.description?.toLowerCase().includes('change-stream') || tool.config.description?.toLowerCase().includes('cursor'),
    'description must mention change-stream or cursor',
  );
});

test('registerRevoMcpTools registers the 3 new observation tools and not the 4 old ones', () => {
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const names = tools.map((tool) => tool.name);

  assert.ok(names.includes('get_run_attention'), 'get_run_attention must be registered');
  assert.ok(names.includes('get_run_status'), 'get_run_status must be registered');
  assert.ok(names.includes('watch_run_changes'), 'watch_run_changes must be registered');

  assert.equal(names.includes('observe_run'), false, 'observe_run must be removed');
  assert.equal(names.includes('wait_for_run'), false, 'wait_for_run must be removed');
  assert.equal(names.includes('wait_for_any_gate'), false, 'wait_for_any_gate must be removed');
  assert.equal(names.includes('watch_runs'), false, 'watch_runs must be removed');
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

test('create_run and start_run schemas accept includeMonitoringGuidance boolean opt-out', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);

  for (const name of ['create_run', 'start_run']) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} must be registered`);
    const schema = z.object(tool.config.inputSchema as Record<string, never>);
    assert.equal(schema.safeParse({ title: 'T', repo: '.', runId: 'r1', includeMonitoringGuidance: false }).success, true, `${name} accepts includeMonitoringGuidance:false`);
    assert.equal(schema.safeParse({ title: 'T', repo: '.', runId: 'r1', includeMonitoringGuidance: true }).success, true, `${name} accepts includeMonitoringGuidance:true`);
    assert.equal(schema.safeParse({ title: 'T', repo: '.', runId: 'r1', includeMonitoringGuidance: 'yes' }).success, false, `${name} rejects non-boolean includeMonitoringGuidance`);
  }
});

test('start_run schema still requires runId alongside optional includeMonitoringGuidance', async () => {
  const { z } = await import('zod');
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const tool = tools.find((t) => t.name === 'start_run');
  assert.ok(tool);
  const schema = z.object(tool.config.inputSchema as Record<string, never>);
  assert.equal(schema.safeParse({ runId: 'r1' }).success, true);
  assert.equal(schema.safeParse({ runId: 'r1', includeMonitoringGuidance: false }).success, true);
  assert.equal(schema.safeParse({ includeMonitoringGuidance: false }).success, false, 'runId is still required');
});

test('monitoring-directive no-drift: buildMonitoringDirective.protocol === OPERATOR_MONITORING_PROTOCOL, MCP_INSTRUCTIONS contains each line, get_run_attention description references shared protocol', () => {
  const { server, tools } = makeServer();
  registerRevoMcpTools(server as never, {} as McpFacadeService);
  const attentionTool = tools.find((t) => t.name === 'get_run_attention');
  assert.ok(attentionTool);

  assert.equal(
    buildMonitoringDirective('r').protocol,
    OPERATOR_MONITORING_PROTOCOL,
    'buildMonitoringDirective.protocol must be the same object reference as OPERATOR_MONITORING_PROTOCOL',
  );

  for (const line of OPERATOR_MONITORING_PROTOCOL) {
    assert.ok(MCP_INSTRUCTIONS.includes(line), `MCP_INSTRUCTIONS must contain protocol line: "${line}"`);
    assert.ok(
      attentionTool.config.description?.includes(line),
      `get_run_attention description must contain protocol line: "${line}"`,
    );
  }

  assert.ok(
    MCP_INSTRUCTIONS.includes('operator/humanGate'),
    'MCP_INSTRUCTIONS must state operator/humanGate monitoring policy',
  );
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
