import test from 'node:test';
import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { assertMcpToolSuccess, McpToolError, mcpToolText } from './mcp-tool-result.js';

test('mcpToolText extracts all text content from a tool result', () => {
  const result = {
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', data: 'abc', mimeType: 'image/png' },
      { type: 'text', text: 'second' },
    ],
  } as CallToolResult;

  assert.equal(mcpToolText(result), 'first\nsecond');
});

test('assertMcpToolSuccess returns successful MCP tool results', () => {
  const result = { content: [{ type: 'text', text: 'ok' }] } as CallToolResult;

  assert.equal(assertMcpToolSuccess(result, 'create_profile'), result);
});

test('assertMcpToolSuccess throws McpToolError for MCP tool execution errors', () => {
  const result = {
    isError: true,
    content: [{ type: 'text', text: 'PROFILE_SCHEMA_CLOSED: bad profile' }],
  } as CallToolResult;

  assert.throws(
    () => assertMcpToolSuccess(result, 'create_profile'),
    (error) => {
      assert.equal(error instanceof McpToolError, true);
      assert.equal((error as McpToolError).result, result);
      assert.match((error as Error).message, /PROFILE_SCHEMA_CLOSED/);
      return true;
    },
  );
});
