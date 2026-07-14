import assert from 'node:assert/strict';
import test from 'node:test';
import { NestFactory } from '@nestjs/core';
import { AcpModule } from '../acp.module.js';
import { AcpRuntimeFactory } from '../acp-runtime.factory.js';
import type { JsonRpcConnection } from '../jsonrpc/connection.types.js';
import type { JsonRpcParams, JsonRpcValue } from '../jsonrpc/types.js';
import type { PermissionResolutionRequest } from '../interaction/request-permission-handler.js';

type Request = { method: string; params: JsonRpcParams | undefined };

function fakeConnection(responses: Record<string, JsonRpcValue>): JsonRpcConnection & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    request(method, params) {
      requests.push({ method, params });
      const response = responses[method];
      if (response === undefined) return Promise.reject(new Error(`missing response for ${method}`));
      return Promise.resolve(response);
    },
    async notify() {},
    async receive() {},
    close() {},
  };
}

test('singleton runtime factory resolves fresh bound transient ACP objects', async (context) => {
  const application = await NestFactory.createApplicationContext(AcpModule, { logger: false });
  context.after(async () => { await application.close(); });
  const factory = application.get(AcpRuntimeFactory);
  assert.strictEqual(application.get(AcpRuntimeFactory), factory);

  const firstFramer = await factory.createFramer();
  const secondFramer = await factory.createFramer();
  const encoder = new TextEncoder();
  assert.deepEqual(firstFramer.push(encoder.encode('{"jsonrpc":"2.0"')), []);
  assert.deepEqual(secondFramer.push(encoder.encode('{"jsonrpc":"2.0","method":"second"}\n')), [
    { jsonrpc: '2.0', method: 'second' },
  ]);
  assert.deepEqual(firstFramer.push(encoder.encode(',"method":"first"}\n')), [
    { jsonrpc: '2.0', method: 'first' },
  ]);

  const firstWrites: Uint8Array[] = [];
  const secondWrites: Uint8Array[] = [];
  const firstConnection = await factory.createConnection({ async write(chunk) { firstWrites.push(chunk); } });
  const secondConnection = await factory.createConnection({ async write(chunk) { secondWrites.push(chunk); } });
  const firstRequest = firstConnection.request('first');
  const secondRequest = secondConnection.request('second');
  await Promise.resolve();
  assert.equal(JSON.parse(new TextDecoder().decode(firstWrites[0]!).trim()).id, 1);
  assert.equal(JSON.parse(new TextDecoder().decode(secondWrites[0]!).trim()).id, 1);
  await firstConnection.receive({ jsonrpc: '2.0', id: 1, result: 'one' });
  await secondConnection.receive({ jsonrpc: '2.0', id: 1, result: 'two' });
  assert.equal(await firstRequest, 'one');
  assert.equal(await secondRequest, 'two');

  const firstSessionConnection = fakeConnection({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: 'first' } });
  const secondSessionConnection = fakeConnection({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: 'second' } });
  const firstSession = await factory.createSession({
    connection: firstSessionConnection,
    configure: async () => {},
    onUpdate: async () => {},
    onDiagnostic: () => {},
  });
  const secondSession = await factory.createSession({
    connection: secondSessionConnection,
    configure: async () => {},
    onUpdate: async () => {},
    onDiagnostic: () => {},
  });
  await Promise.all([firstSession.initialize(), secondSession.initialize()]);
  await Promise.all([firstSession.create(), secondSession.create()]);
  assert.equal(firstSession.getSessionId(), 'first');
  assert.equal(secondSession.getSessionId(), 'second');
  assert.deepEqual(firstSessionConnection.requests.map(({ method }) => method), ['initialize', 'session/new']);
  assert.deepEqual(secondSessionConnection.requests.map(({ method }) => method), ['initialize', 'session/new']);

  const firstPermissionRequests: PermissionResolutionRequest[] = [];
  const secondPermissionRequests: PermissionResolutionRequest[] = [];
  const firstRequestPermissionHandler = await factory.createRequestPermissionHandler({
    expectedSessionId: 'permission-first',
    async resolvePermission(request) {
      firstPermissionRequests.push(request);
      return { outcome: 'select', optionKind: 'allow_once' };
    },
  });
  const secondRequestPermissionHandler = await factory.createRequestPermissionHandler({
    expectedSessionId: 'permission-second',
    async resolvePermission(request) {
      secondPermissionRequests.push(request);
      return { outcome: 'select', optionKind: 'reject_once' };
    },
  });
  assert.notStrictEqual(firstRequestPermissionHandler, secondRequestPermissionHandler);

  const firstPermissionResult = await firstRequestPermissionHandler.handle({
    sessionId: 'permission-first',
    toolCall: { toolCallId: 'tool-first' },
    options: [{ optionId: 'allow-first', name: 'Allow first', kind: 'allow_once' }],
  });
  const secondPermissionResult = await secondRequestPermissionHandler.handle({
    sessionId: 'permission-second',
    toolCall: { toolCallId: 'tool-second' },
    options: [{ optionId: 'reject-second', name: 'Reject second', kind: 'reject_once' }],
  });
  assert.deepEqual(firstPermissionResult, {
    outcome: 'selected',
    response: { outcome: { outcome: 'selected', optionId: 'allow-first' } },
  });
  assert.deepEqual(secondPermissionResult, {
    outcome: 'selected',
    response: { outcome: { outcome: 'selected', optionId: 'reject-second' } },
  });
  assert.deepEqual(firstPermissionRequests.map(({ sessionId, toolCallId }) => ({ sessionId, toolCallId })), [
    { sessionId: 'permission-first', toolCallId: 'tool-first' },
  ]);
  assert.deepEqual(secondPermissionRequests.map(({ sessionId, toolCallId }) => ({ sessionId, toolCallId })), [
    { sessionId: 'permission-second', toolCallId: 'tool-second' },
  ]);

  const firstPromptOutcomeCollector = await factory.createPromptOutcomeCollector({
    expectedSessionId: 'outcome-first',
  });
  const secondPromptOutcomeCollector = await factory.createPromptOutcomeCollector({
    expectedSessionId: 'outcome-second',
  });
  assert.notStrictEqual(firstPromptOutcomeCollector, secondPromptOutcomeCollector);
  assert.deepEqual(firstPromptOutcomeCollector.collect({
    kind: 'agent-text',
    sessionId: 'outcome-first',
    text: 'first',
  }), { outcome: 'accepted' });
  assert.deepEqual(secondPromptOutcomeCollector.collect({
    kind: 'agent-text',
    sessionId: 'outcome-second',
    text: 'second',
  }), { outcome: 'accepted' });
  assert.deepEqual(firstPromptOutcomeCollector.snapshot(), {
    sessionId: 'outcome-first',
    text: 'first',
    diagnostics: [],
  });
  assert.deepEqual(secondPromptOutcomeCollector.snapshot(), {
    sessionId: 'outcome-second',
    text: 'second',
    diagnostics: [],
  });
});
