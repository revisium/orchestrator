import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ControlPlaneError } from '../control-plane/errors.js';

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

export function serializeMcpToolError(error: unknown): CallToolResult {
  const controlPlaneError = error instanceof ControlPlaneError;
  const details = controlPlaneError && isRecord(error.details) ? error.details : undefined;
  const payload = {
    code: typeof details?.code === 'string' ? details.code : controlPlaneError ? error.code : 'INTERNAL_ERROR',
    message: controlPlaneError ? error.message : 'Internal MCP tool error',
    ...(typeof details?.path === 'string' ? { path: details.path } : {}),
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
