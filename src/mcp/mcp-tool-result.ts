import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export class McpToolError extends Error {
  constructor(
    message: string,
    readonly result: CallToolResult,
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

export function mcpToolText(result: Pick<CallToolResult, 'content'>): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function assertMcpToolSuccess(result: CallToolResult, toolName = 'MCP tool'): CallToolResult {
  if (result.isError === true) {
    const message = mcpToolText(result).trim() || `${toolName} failed`;
    throw new McpToolError(message, result);
  }
  return result;
}
