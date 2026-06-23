/**
 * McpHttpService — hosts the Revo MCP server over StreamableHTTP inside the host daemon (ADR 0006),
 * so `revo mcp` can be a thin stdio→HTTP bridge instead of building its own AppModule + DBOS.
 *
 * Stateless: a fresh McpServer + transport per request (Revo's tools are request/response; no
 * server-initiated sessions/streaming needed). Same tool surface as the stdio path — both register
 * `registerRevoMcpTools` over the one in-daemon McpFacadeService, so the bridge needs no GraphQL
 * mapping and every tool runs against the single DBOS-owning host.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { readPackageVersion } from '../package-info.js';
import { MCP_INSTRUCTIONS } from './mcp-capabilities.js';
import { McpFacadeService } from './mcp-facade.service.js';
import { registerRevoMcpTools } from './mcp-tools.js';

/** Cap the request body so a malformed/oversized local request can't balloon daemon memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Plain class (not a Nest provider): the daemon constructs it with a DI-resolved McpFacadeService
 * (`app.get(McpFacadeService)`) and a port. Keeping it out of the provider graph avoids a DI edge
 * that left the injected facade undefined when resolved via the host app.
 */
export class McpHttpService {
  constructor(private readonly facade: McpFacadeService) {}

  /** Bind the MCP endpoint on 127.0.0.1:port. Returns the http.Server so the daemon can close it. */
  async start(port: number): Promise<HttpServer> {
    const server = createServer((req, res) => {
      this.dispatch(req, res).catch(() => {
        // A dispatch failure must still return a deterministic response, never an unhandled rejection.
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  }

  /** Handle one HTTP request: POST → a fresh stateless McpServer + StreamableHTTP transport; else 405. */
  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400).end();
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = new McpServer({ name: 'revo', version: readPackageVersion() }, { instructions: MCP_INSTRUCTIONS });
    registerRevoMcpTools(server, this.facade);
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
