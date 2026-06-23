import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readPackageVersion } from '../../package-info.js';
import { ensureHost } from '../../host/ensure-host.js';
import { readHostRuntime } from '../../host/host-runtime.js';

/**
 * `revo mcp` — a thin stdio↔daemon MCP bridge (ADR 0006). It ensures the host daemon is up, then
 * proxies tool list/call from the stdio client (Claude Code) to the daemon's in-process MCP server
 * over StreamableHTTP. It does NOT build AppModule or launch DBOS — the daemon is the single DBOS
 * owner, so every tool runs against the one host and read tools never trigger a recovery pass.
 */
async function runMcpBridge(): Promise<void> {
  await ensureHost();
  const runtime = readHostRuntime();
  if (!runtime) {
    console.error('Revo host daemon is not available — run `revo start`.');
    process.exitCode = 1;
    return;
  }

  const version = readPackageVersion();
  const upstream = new Client({ name: 'revo-mcp-bridge', version });
  await upstream.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.mcpPort}/mcp`)));

  // Downstream stdio server (faces Claude Code) — forwards tools to the daemon's MCP server.
  const server = new Server({ name: 'revo', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));

  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });

  try {
    await server.connect(transport);
    await closed;
  } finally {
    await upstream.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

export function registerMcp(program: Command): void {
  program
    .command('mcp')
    .description('Start the local stdio MCP server (bridges to the running Revo daemon)')
    .action(() => runMcpBridge());
}
