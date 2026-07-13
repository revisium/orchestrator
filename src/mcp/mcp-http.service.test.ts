import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpHttpService } from './mcp-http.service.js';
import type { McpFacadeService } from './mcp-facade.service.js';
import { assertMcpToolSuccess, McpToolError, mcpToolText } from './mcp-tool-result.js';

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const profileBody = {
  schemaVersion: 'run-profile/v1',
  topology: { stages: { developer: { mode: 'single' } } },
  bindings: { slots: { 'node:developer': { runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {} } } },
};

async function withMcpClient<T>(facade: McpFacadeService, fn: (client: Client) => Promise<T>): Promise<T> {
  const httpServer = await new McpHttpService(facade).start(0);
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: 'mcp-http-profile-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
    httpServer.close();
  }
}

/**
 * The full production abort chain, end to end over a real socket: a held long-poll tool call
 * is torn down when the client disconnects. McpHttpService registers `res.on('close') → server.close()`;
 * the SDK's protocol _onclose() then aborts the in-flight request's AbortController, which surfaces as
 * the tool handler's `extra.signal`. This is the link the unit tests (which fire a manual
 * AbortController) and the e2e (single-arg invoker, no signal) cannot cover.
 */
test('McpHttpService: a client disconnect mid-long-poll aborts the in-flight tool handler signal', async () => {
  let sawAbort = false;
  let resolveAborted: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  let signalReached: () => void = () => {};
  const handlerReached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });

  // The facade's long-poll resolves ONLY when its AbortSignal fires — so the test can only pass if the
  // transport close actually propagates an abort to the handler. It signals `handlerReached` once the
  // abort listener is attached, so the test disconnects on that fact, not a fixed sleep (no race).
  const facade = {
    async watchRunChanges(input: { signal?: AbortSignal }) {
      return new Promise((resolve) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            resolveAborted();
            resolve({ transitions: [], cursor: 'x', timedOut: true });
          },
          { once: true },
        );
        signalReached();
      });
    },
  } as unknown as McpFacadeService;

  const httpServer = await new McpHttpService(facade).start(0);
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: 'mcp-http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  try {
    const call = client
      .callTool({ name: 'watch_run_changes', arguments: { runId: 'r1', timeoutMs: 30_000 } })
      .catch(() => undefined); // closing the connection rejects/aborts the client call — result irrelevant
    await handlerReached; // the handler attached its abort listener — safe to disconnect (no race)
    await client.close(); // drop the connection → server res.on('close') fires while the handler is held

    await Promise.race([aborted, tick(2_000)]);
    assert.equal(sawAbort, true, 'a client disconnect aborts the held tool handler (no dangling 45s request)');
    await call;
  } finally {
    httpServer.close();
  }
});

test('McpHttpService: tool handler application errors are surfaced as MCP tool errors', async () => {
  const facade = {
    async validateProfile() {
      throw new Error('PROFILE_SCHEMA_CLOSED: topology stage "bad" does not exist');
    },
  } as unknown as McpFacadeService;

  const httpServer = await new McpHttpService(facade).start(0);
  const port = (httpServer.address() as AddressInfo).port;
  const client = new Client({ name: 'mcp-http-error-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));

  try {
    const result = await client.callTool({
      name: 'validate_profile',
      arguments: {
        pipelineId: 'analysis-only',
        profile: {
          schemaVersion: 'run-profile/v1',
          topology: { stages: { analyst: { mode: 'single' } } },
          bindings: { slots: { 'node:analyst': { runnerId: 'codex', provider: 'openai', modelId: 'gpt-5.6-luna', modelParams: {} } } },
        },
      },
    });

    assert.equal(result.isError, true, 'application failures must be marked as MCP tool errors');
    const toolResult = result as CallToolResult;
    assert.throws(() => assertMcpToolSuccess(toolResult, 'validate_profile'), McpToolError);
    assert.equal(mcpToolText(toolResult), '{"code":"INTERNAL_ERROR","message":"Internal MCP tool error"}');
  } finally {
    await client.close().catch(() => undefined);
    httpServer.close();
  }
});

test('McpHttpService: profile management tools work over the real MCP HTTP transport', async () => {
  const calls: Array<[string, unknown]> = [];
  const compactProfile = {
    profileId: 'custom-exact',
    pipelineId: 'local-change',
    version: '1',
    displayName: 'Custom exact',
    summary: 'Custom profile',
    profileHash: 'profile-hash',
    profileRevisionHash: 'revision-hash',
    status: 'active',
  };
  const facade = {
    async listProfiles(input: unknown) {
      calls.push(['list', input]);
      return [compactProfile];
    },
    async getProfile(input: unknown) {
      calls.push(['get', input]);
      return compactProfile;
    },
    async createProfile(input: unknown) {
      calls.push(['create', input]);
      return compactProfile;
    },
    async updateProfile(input: unknown) {
      calls.push(['update', input]);
      return { ...compactProfile, profileRevisionHash: 'revision-hash-2' };
    },
    async deprecateProfile(input: unknown) {
      calls.push(['deprecate', input]);
      return { ...compactProfile, status: 'deprecated' };
    },
  } as unknown as McpFacadeService;

  await withMcpClient(facade, async (client) => {
    const list = await client.callTool({ name: 'list_profiles', arguments: { pipelineId: 'local-change' } });
    const get = await client.callTool({ name: 'get_profile', arguments: { pipelineId: 'local-change', profileId: 'custom-exact' } });
    const create = await client.callTool({
      name: 'create_profile',
      arguments: { pipelineId: 'local-change', profileId: 'custom-exact', displayName: 'Custom exact', profile: profileBody },
    });
    const update = await client.callTool({
      name: 'update_profile',
      arguments: { pipelineId: 'local-change', profileId: 'custom-exact', expectedProfileRevisionHash: 'revision-hash', profile: profileBody },
    });
    const deprecate = await client.callTool({
      name: 'deprecate_profile',
      arguments: { pipelineId: 'local-change', profileId: 'custom-exact', expectedProfileRevisionHash: 'revision-hash-2' },
    });

    for (const result of [list, get, create, update, deprecate]) {
      const toolResult = result as CallToolResult;
      assertMcpToolSuccess(toolResult);
      assert.ok(mcpToolText(toolResult).includes('custom-exact'));
    }
  });

  assert.deepEqual(calls, [
    ['list', { pipelineId: 'local-change' }],
    ['get', { pipelineId: 'local-change', profileId: 'custom-exact' }],
    ['create', { pipelineId: 'local-change', profileId: 'custom-exact', displayName: 'Custom exact', profile: profileBody }],
    ['update', { pipelineId: 'local-change', profileId: 'custom-exact', expectedProfileRevisionHash: 'revision-hash', profile: profileBody }],
    ['deprecate', { pipelineId: 'local-change', profileId: 'custom-exact', expectedProfileRevisionHash: 'revision-hash-2' }],
  ]);
});

test('McpHttpService: invalid profile management requests are MCP tool errors and keep the session usable', async () => {
  const calls: string[] = [];
  const facade = {
    async createProfile() {
      calls.push('create');
      return { ok: true };
    },
    async updateProfile() {
      calls.push('update');
      return { ok: true };
    },
    async listProfiles(input: unknown) {
      calls.push('list');
      return [{ profileId: 'custom-exact', pipelineId: (input as { pipelineId?: string }).pipelineId ?? 'local-change' }];
    },
  } as unknown as McpFacadeService;

  await withMcpClient(facade, async (client) => {
    const invalidCreate = await client.callTool({
      name: 'create_profile',
      arguments: {
        pipelineId: 'local-change',
        profileId: 'custom-exact',
        displayName: 'Custom exact',
        profile: { ...profileBody, pipelineId: 'local-change' },
      },
    });
    assert.equal(invalidCreate.isError, true, 'schema failures must be returned as MCP tool errors');
    const invalidCreateResult = invalidCreate as CallToolResult;
    assert.throws(() => assertMcpToolSuccess(invalidCreateResult, 'create_profile'), McpToolError);
    assert.match(mcpToolText(invalidCreateResult), /pipelineId|unrecognized/i);

    const invalidUpdate = await client.callTool({
      name: 'update_profile',
      arguments: {
        pipelineId: 'local-change',
        profileId: 'custom-exact',
        profile: profileBody,
      },
    });
    assert.equal(invalidUpdate.isError, true, 'missing optimistic lock must be returned as a MCP tool error');
    const invalidUpdateResult = invalidUpdate as CallToolResult;
    assert.throws(() => assertMcpToolSuccess(invalidUpdateResult, 'update_profile'), McpToolError);
    assert.match(mcpToolText(invalidUpdateResult), /expectedProfileRevisionHash/i);

    const afterError = await client.callTool({ name: 'list_profiles', arguments: { pipelineId: 'local-change' } });
    assertMcpToolSuccess(afterError as CallToolResult, 'list_profiles');
  });

  assert.deepEqual(calls, ['list'], 'invalid schema calls must not reach profile mutation handlers');
});
