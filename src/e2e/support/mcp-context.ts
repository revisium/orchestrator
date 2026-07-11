import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../../config.js';
import { readHostRuntime } from '../../host/host-runtime.js';
import { McpFacadeService } from '../../mcp/mcp-facade.service.js';
import { McpHttpService } from '../../mcp/mcp-http.service.js';
import { mcpToolText } from '../../mcp/mcp-tool-result.js';
import { createTargetRepo, type TargetRepo } from './git-target-repo.js';
import { createHostFixture } from './harness.js';
import { stubDefaultAgentProfile } from './run-profiles.js';
import { givenInstalledPlaybook } from './scenarios.js';

export type McpResult<T = unknown> = Readonly<{
  isError: boolean;
  text: string;
  data?: T;
}>;

export type McpAttention = Readonly<{
  runId: string;
  state: string;
  nextAction: string;
  requiresAttention: boolean;
  inbox?: Readonly<{ id: string }>;
}>;

export type McpWatchChanges = Readonly<{
  transitions: readonly Readonly<{
    runId: string;
    state: string;
    inbox?: Readonly<{ id: string }>;
  }>[];
  cursor: string;
  timedOut: boolean;
}>;

type McpInboxItem = Readonly<{
  id: string;
  kind: string;
  status: string;
  options: readonly string[];
  context?: Readonly<Record<string, unknown>>;
}>;

export type McpGate = Readonly<{
  topic: string;
  options: readonly string[];
}>;

type McpRunStatus = Readonly<{
  state: string;
  runStatus: string;
  workflowStatus: string;
}>;

const TERMINAL_RUN_STATES = new Set(['completed', 'cancelled', 'failed', 'blocked']);
const TERMINAL_WORKFLOW_STATES = new Set(['SUCCESS', 'ERROR', 'CANCELLED']);
const CLEANUP_GATE_OUTCOMES = new Set(['cancel', 'abort', 'give_up']);

type RegisterMcpCasePlan = (input: Readonly<{
  taskId: string;
  title: string;
  pipelineId: 'local-change' | 'feature-development';
  target: TargetRepo;
}>) => void;

function processEnvironment(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete inherited['REVO_PROFILE'];
  return { ...inherited, ...overrides };
}

function parseToolData<T>(result: CallToolResult, text: string): T | undefined {
  if (result.isError === true || text.trim() === '') return undefined;
  return JSON.parse(text) as T;
}

export class McpContext {
  readonly #client: Client;
  readonly #transport: StdioClientTransport;
  readonly #targetFactory: () => TargetRepo;
  readonly #registerCasePlan: RegisterMcpCasePlan;
  readonly #closeSupport: () => Promise<void>;
  readonly #targets = new Set<TargetRepo>();
  readonly #runs = new Map<string, TargetRepo>();

  constructor(
    client: Client,
    transport: StdioClientTransport,
    targetFactory: () => TargetRepo = createTargetRepo,
    registerCasePlan: RegisterMcpCasePlan = () => undefined,
    closeSupport: () => Promise<void> = async () => undefined,
  ) {
    this.#client = client;
    this.#transport = transport;
    this.#targetFactory = targetFactory;
    this.#registerCasePlan = registerCasePlan;
    this.#closeSupport = closeSupport;
  }

  async toolNames(): Promise<readonly string[]> {
    const listed = await this.#client.listTools();
    return listed.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
  }

  async call<T = unknown>(name: string, args: Readonly<Record<string, unknown>> = {}): Promise<McpResult<T>> {
    const result = await this.#client.callTool({ name, arguments: args }) as CallToolResult;
    const text = mcpToolText(result);
    return {
      isError: result.isError === true,
      text,
      ...(result.isError === true ? {} : { data: parseToolData<T>(result, text) }),
    };
  }

  async gate(inboxId: string): Promise<McpResult<McpGate>> {
    const result = await this.call<McpInboxItem>('get_inbox_item', { inboxId });
    if (result.isError || !result.data) return { isError: true, text: result.text };
    const topic = result.data.context?.['topic'];
    if (typeof topic !== 'string') {
      return { isError: true, text: `inbox ${inboxId} does not expose a string gate topic` };
    }
    return {
      isError: false,
      text: result.text,
      data: { topic, options: result.data.options },
    };
  }

  async createRun(input: Readonly<{
    title: string;
    pipelineId: 'local-change' | 'feature-development';
    start: boolean;
  }>): Promise<McpResult<{ runId: string; taskId: string }>> {
    const target = this.#targetFactory();
    this.#targets.add(target);
    const result = await this.call<{ runId: string; taskId: string }>('create_run', {
      title: input.title,
      repo: target.worktree,
      pipelineId: input.pipelineId,
      profile: stubDefaultAgentProfile(),
      start: false,
    });
    if (!result.isError && result.data?.runId && result.data.taskId) {
      this.#runs.set(result.data.runId, target);
      this.#registerCasePlan({
        taskId: result.data.taskId,
        title: input.title,
        pipelineId: input.pipelineId,
        target,
      });
      if (input.start) {
        const started = await this.call('start_run', { runId: result.data.runId });
        if (started.isError) return { isError: true, text: started.text };
      }
    }
    return result;
  }

  async attentionUntil(runId: string, nextAction: string): Promise<McpResult<McpAttention>> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const result = await this.call<McpAttention>('get_run_attention', { runId });
      if (result.isError || result.data?.nextAction === nextAction || result.data?.nextAction === 'done') return result;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`run ${runId} did not reach nextAction=${nextAction} within 10 seconds`);
  }

  async watchUntil(
    runId: string,
    state: string,
    cursor?: string,
  ): Promise<Readonly<{ result: McpResult<McpWatchChanges>; cursor?: string; inboxId?: string }>> {
    let nextCursor = cursor;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.call<McpWatchChanges>('watch_run_changes', {
        runId,
        timeoutMs: 5_000,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      });
      if (result.isError) return { result, cursor: nextCursor };
      nextCursor = result.data?.cursor ?? nextCursor;
      const transition = result.data?.transitions.find((candidate) => candidate.state === state);
      if (transition) return { result, cursor: nextCursor, inboxId: transition.inbox?.id };
    }
    throw new Error(`run ${runId} did not expose state=${state} through watch_run_changes`);
  }

  async eventsUntil(runId: string, type: string): Promise<McpResult<readonly { type: string }[]>> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const result = await this.call<readonly { type: string }[]>('get_run_events', { runId, limit: 500 });
      if (result.isError || result.data?.some((event) => event.type === type)) return result;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`run ${runId} did not expose event=${type} within 8 seconds`);
  }

  async cleanupRun(runId: string): Promise<void> {
    const target = this.#runs.get(runId);
    if (!target) return;
    await this.#settleRunThroughMcp(runId);
    this.#runs.delete(runId);
    this.#targets.delete(target);
    target.cleanup();
  }

  async #settleRunThroughMcp(runId: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const attention = await this.call<McpAttention>('get_run_attention', { runId });
      if (attention.isError) {
        if (/ROW_NOT_FOUND|not found/i.test(attention.text)) return;
        throw new Error(`MCP cleanup could not inspect ${runId}: ${attention.text}`);
      }
      const state = attention.data?.state;
      if ((state && TERMINAL_RUN_STATES.has(state)) || attention.data?.nextAction === 'done') {
        const status = await this.call<McpRunStatus>('get_run_status', { runId });
        if (status.isError || !status.data) {
          throw new Error(`MCP cleanup could not inspect workflow status for ${runId}: ${status.text}`);
        }
        if (TERMINAL_WORKFLOW_STATES.has(status.data.workflowStatus)) return;
        if (status.data.state === 'cancelled' && status.data.runStatus === 'cancelled') return;
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (attention.data?.inbox?.id) {
        await this.#resolveCleanupInbox(attention.data.inbox.id);
        continue;
      }
      if (state === 'ready' || state === 'running') {
        const cancelled = await this.call('cancel_run', { runId });
        if (cancelled.isError) throw new Error(`MCP cleanup could not cancel ${runId}: ${cancelled.text}`);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`MCP cleanup could not settle workflow ${runId} through the public boundary`);
  }

  async #resolveCleanupInbox(inboxId: string): Promise<void> {
    const result = await this.call<McpInboxItem>('get_inbox_item', { inboxId });
    if (result.isError || !result.data) {
      throw new Error(`MCP cleanup could not inspect inbox ${inboxId}: ${result.text}`);
    }
    if (result.data.kind === 'question') {
      const resolved = await this.call('resolve_inbox_item', {
        inboxId,
        answer: { cancelled: true, reason: 'stdio e2e cleanup' },
        resolvedBy: 'mcp-stdio-e2e-cleanup',
      });
      if (resolved.isError) throw new Error(`MCP cleanup could not resolve question ${inboxId}: ${resolved.text}`);
      return;
    }
    const allowed = result.data.options.filter((outcome) => CLEANUP_GATE_OUTCOMES.has(outcome));
    if (allowed.length !== 1) {
      throw new Error(
        `MCP cleanup expected one terminal outcome for ${inboxId}; got ${JSON.stringify(result.data.options)}`,
      );
    }
    const resolved = await this.call('resolve_gate', {
      inboxId,
      outcome: allowed[0],
      resolvedBy: 'mcp-stdio-e2e-cleanup',
    });
    if (resolved.isError) throw new Error(`MCP cleanup could not resolve gate ${inboxId}: ${resolved.text}`);
  }

  async close(): Promise<void> {
    const cleanupErrors: unknown[] = [];
    try {
      for (const runId of [...this.#runs.keys()]) {
        try {
          await this.cleanupRun(runId);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      await this.#client.close().catch((error) => cleanupErrors.push(error));
      await this.#transport.close().catch((error) => cleanupErrors.push(error));
      await this.#closeSupport().catch((error) => cleanupErrors.push(error));
      for (const target of this.#targets) {
        try {
          target.cleanup();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      this.#targets.clear();
      this.#runs.clear();
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'MCP context cleanup failed');
  }
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function createMcpContext(): Promise<McpContext> {
  const host = await createHostFixture();
  let mcpServer: HttpServer | undefined;
  let bridgeDataDir: string | undefined;
  const client = new Client({ name: 'revo-stdio-e2e', version: '0.0.0' });
  try {
    await givenInstalledPlaybook(host);
    mcpServer = await new McpHttpService(new McpFacadeService(host.api)).start(0);
    const address = mcpServer.address();
    assert.ok(address && typeof address === 'object');
    const sharedRuntime = readHostRuntime();
    assert.ok(sharedRuntime, 'the shared e2e host must be running before MCP surface tests');
    bridgeDataDir = mkdtempSync(join(tmpdir(), 'revo-mcp-stdio-'));
    writeFileSync(join(bridgeDataDir, 'host.json'), JSON.stringify({
      pid: process.pid,
      graphqlPort: sharedRuntime.graphqlPort,
      mcpPort: address.port,
      startedAt: new Date().toISOString(),
      profile: 'mcp-stdio-e2e',
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', join(repoRoot, 'src/cli/index.ts'), 'mcp'],
      cwd: repoRoot,
      env: processEnvironment({ REVO_DATA_DIR: bridgeDataDir }),
      stderr: 'pipe',
    });
    await client.connect(transport);
    return new McpContext(
      client,
      transport,
      createTargetRepo,
      ({ taskId, title, pipelineId, target }) => host.casePlans.register(taskId, {
        title,
        ...(pipelineId === 'feature-development' ? { developerWrite: target.worktree } : {}),
      }),
      async () => {
        if (mcpServer) await closeHttpServer(mcpServer);
        await host.close();
        if (bridgeDataDir) rmSync(bridgeDataDir, { recursive: true, force: true });
      },
    );
  } catch (error) {
    await client.close().catch(() => undefined);
    if (mcpServer) await closeHttpServer(mcpServer).catch(() => undefined);
    await host.close().catch(() => undefined);
    if (bridgeDataDir) rmSync(bridgeDataDir, { recursive: true, force: true });
    throw error;
  }
}
