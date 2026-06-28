import { Command } from 'commander';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readPackageVersion } from '../../package-info.js';
import { ensureHost } from '../../host/ensure-host.js';
import { readHostRuntime } from '../../host/host-runtime.js';





const INNER_HOP_TIMEOUT_MS = 60_000;





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

  const server = new Server({ name: 'revo', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    upstream.callTool(request.params, undefined, { timeout: INNER_HOP_TIMEOUT_MS }),
  );

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
