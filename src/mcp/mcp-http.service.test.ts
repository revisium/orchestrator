import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpHttpService } from './mcp-http.service.js';
import type { McpFacadeService } from './mcp-facade.service.js';

const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
