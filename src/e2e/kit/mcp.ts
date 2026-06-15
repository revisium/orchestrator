import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpFacadeService } from '../../mcp/mcp-facade.service.js';
import { registerRevoMcpTools } from '../../mcp/mcp-tools.js';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';

type ToolReg = { inputSchema: Record<string, z.ZodTypeAny>; handler: (args: unknown) => unknown };

export type McpInvoker = {
  /** Tool names registered by the real MCP layer (should equal MCP_TOOL_NAMES). */
  toolNames: string[];
  /**
   * Drive an MCP tool exactly as the stdio server would: validate `args` against the tool's zod
   * inputSchema (throws ZodError on bad/missing args), run the registered handler, and return the
   * parsed JSON result the client would receive. Errors from the facade/API propagate as-is.
   */
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Build the REAL MCP surface over the test API: the `McpFacadeService` + the tool handlers from
 * `registerRevoMcpTools`, captured via a recording server so a test can invoke a tool by name
 * in-process. This exercises the same schema validation, dispatch, and `{content:[{text}]}` result
 * shape the live stdio server uses — i.e. the MCP layer itself, not just the underlying API.
 */
export function createMcpInvoker(api: TaskControlPlaneApiService): McpInvoker {
  const facade = new McpFacadeService(api);
  const tools = new Map<string, ToolReg>();
  const recordingServer = {
    registerTool(
      name: string,
      config: { inputSchema?: Record<string, z.ZodTypeAny> },
      handler: (args: unknown) => unknown,
    ): void {
      tools.set(name, { inputSchema: config.inputSchema ?? {}, handler });
    },
  } as unknown as McpServer;
  registerRevoMcpTools(recordingServer, facade);

  return {
    toolNames: [...tools.keys()],
    async invoke(name, args = {}) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`unknown MCP tool: ${name}`);
      const parsed = z.object(tool.inputSchema).parse(args); // SDK-equivalent validation (defaults + reject)
      const result = (await tool.handler(parsed)) as { content?: Array<{ text?: string }> };
      const text = result?.content?.[0]?.text;
      return text === undefined ? result : JSON.parse(text);
    },
  };
}
