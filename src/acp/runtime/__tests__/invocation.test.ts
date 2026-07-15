import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpJsonRpcConnection } from '../../jsonrpc/connection.js';
import { parseJsonRpcLine } from '../../jsonrpc/parser.js';
import type {
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcValue,
} from '../../jsonrpc/types.js';
import { AcpPermissionRequestHandler } from '../../prompt-execution/permission-request-handler.js';
import {
  AcpPromptOutcomeCollector,
  type AcpPromptOutcome,
} from '../../prompt-execution/prompt-outcome-collector.js';
import { AcpSession } from '../../session/session.js';
import {
  AcpInvocationError,
  normalizeAcpDiagnosticDetails,
  runAcpInvocationWithComponents,
  type AcpInvocationComponents,
  type AcpInvocationDependencies,
  type AcpInvocationDiagnostic,
  type AcpInvocationRequest,
  type AcpOpenConnection,
} from '../invocation.js';

function runInvocation(
  request: AcpInvocationRequest,
  deps: AcpInvocationDependencies,
): Promise<AcpPromptOutcome> {
  return runAcpInvocationWithComponents(request, deps, {
    session: new AcpSession(),
    permissionHandler: new AcpPermissionRequestHandler(),
    outcomeCollector: new AcpPromptOutcomeCollector(),
  });
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
type ScriptedInboundFrame = Readonly<{
  kind: 'frame'; sequence: number; message: JsonRpcMessage; deliveryGate?: Promise<void>;
}>;
type ScriptedCompletionMarker = Readonly<{
  kind: 'completion-marker'; cutoff: number; resolve(): void;
}>;
type ScriptedInboundEntry = ScriptedInboundFrame | ScriptedCompletionMarker;
type ScriptedPeer = Readonly<{
  openConnection: AcpOpenConnection;
  queueInbound(message: JsonRpcMessage, deliveryGate?: Promise<void>): void;
  setOnOutboundRequest(handler: (request: JsonRpcRequest) => void): void;
  setOnOutboundResponse(handler: (response: JsonRpcResponse) => void): void;
  setOnCompletionBarrier(handler: (cutoff: number) => void): void;
  rejectNextWrite(error: unknown): void;
  resolveInboundFailure(value: unknown): void;
  rejectInboundFailure(reason: unknown): void;
  outboundRequests(): readonly JsonRpcRequest[];
  outboundResponses(): readonly JsonRpcResponse[];
  startCalls(): number;
  receiveCalls(): number;
  maxConcurrentReceive(): number;
  barrierCutoffs(): readonly number[];
  deliveredFrameSequences(): readonly number[];
  waitForIdle(): Promise<void>;
}>;

function safeTestError(value: unknown): Error {
  try { if (value instanceof Error) return value; } catch {}
  return new Error('Scripted ACP peer received a non-Error failure');
}

function parseOutboundMessage(chunk: Uint8Array): JsonRpcMessage {
  const frame = new TextDecoder().decode(chunk);
  const message = parseJsonRpcLine(frame.endsWith('\n') ? frame.slice(0, -1) : frame);
  if (!message) throw new Error('Scripted ACP peer received an empty outbound frame');
  return message;
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return Object.hasOwn(message, 'method') && Object.hasOwn(message, 'id');
}

function isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return !Object.hasOwn(message, 'method');
}

function responseFor(request: JsonRpcRequest, result: JsonRpcValue): JsonRpcMessage {
  return { jsonrpc: '2.0', id: request.id, result };
}

function createScriptedPeer(): ScriptedPeer {
  const inboundQueue: ScriptedInboundEntry[] = [];
  const requests: JsonRpcRequest[] = [];
  const responses: JsonRpcResponse[] = [];
  const cutoffs: number[] = [];
  const deliveredSequences: number[] = [];
  let onOutboundRequest: ((request: JsonRpcRequest) => void) | undefined;
  let onOutboundResponse: ((response: JsonRpcResponse) => void) | undefined;
  let onCompletionBarrier: ((cutoff: number) => void) | undefined;
  let nextWriteFailure: unknown;
  let started = false;
  let stopped = false;
  let starts = 0;
  let receives = 0;
  let activeReceives = 0;
  let maxReceives = 0;
  let lastAcceptedSequence = 0;
  let lastDeliveredSequence = 0;
  let drainScheduled = false;
  let drainTail = Promise.resolve();
  let resolveInbound!: (value: Error) => void;
  let rejectInbound!: (reason: unknown) => void;
  const inboundFailure = new Promise<Error>((resolve, reject) => {
    resolveInbound = resolve;
    rejectInbound = reject;
  });
  const connection = new AcpJsonRpcConnection();

  const settleReceiveFailure = (reason: unknown): void => {
    if (stopped) return;
    stopped = true;
    resolveInbound(safeTestError(reason));
  };
  const drain = async (): Promise<'empty' | 'marker'> => {
    while (started && !stopped && inboundQueue.length > 0) {
      const entry = inboundQueue.shift();
      if (!entry) return 'empty';
      if (entry.kind === 'completion-marker') {
        if (lastDeliveredSequence !== entry.cutoff) {
          throw new Error('ACP scripted completion marker crossed an undelivered pre-barrier frame');
        }
        entry.resolve();
        return 'marker';
      }
      if (entry.deliveryGate) await entry.deliveryGate;
      receives += 1;
      activeReceives += 1;
      maxReceives = Math.max(maxReceives, activeReceives);
      try {
        await connection.receive(entry.message);
        lastDeliveredSequence = entry.sequence;
        deliveredSequences.push(entry.sequence);
      } catch (error) {
        lastDeliveredSequence = entry.sequence;
        deliveredSequences.push(entry.sequence);
        settleReceiveFailure(error);
      } finally {
        activeReceives -= 1;
      }
    }
    return 'empty';
  };
  async function runScheduledDrain(): Promise<void> {
    const stopReason = await drain();
    drainScheduled = false;
    if (!started || stopped || inboundQueue.length === 0) return;
    if (stopReason === 'marker') { queueMicrotask(scheduleDrain); return; }
    scheduleDrain();
  }
  function scheduleDrain(): void {
    if (drainScheduled) return;
    drainScheduled = true;
    drainTail = drainTail.then(runScheduledDrain, runScheduledDrain);
    void drainTail.catch(settleReceiveFailure);
  }
  const queueInbound = (message: JsonRpcMessage, deliveryGate?: Promise<void>): void => {
    lastAcceptedSequence += 1;
    inboundQueue.push({
      kind: 'frame', sequence: lastAcceptedSequence, message,
      ...(deliveryGate === undefined ? {} : { deliveryGate }),
    });
    if (started) scheduleDrain();
  };
  const openConnection: AcpOpenConnection = async (nextHandlers) => {
    connection.bindDependencies({
      async write(chunk) {
        if (nextWriteFailure !== undefined) {
          const failure = nextWriteFailure;
          nextWriteFailure = undefined;
          throw failure;
        }
        const message = parseOutboundMessage(chunk);
        if (isRequest(message)) { requests.push(message); onOutboundRequest?.(message); return; }
        if (isResponse(message)) { responses.push(message); onOutboundResponse?.(message); return; }
        throw new Error('Scripted ACP peer does not accept outbound notifications');
      },
      onRequest: nextHandlers.onRequest,
      onNotification: nextHandlers.onNotification,
    });
    return {
      connection,
      inboundFailure,
      start() {
        if (started) throw new Error('ACP scripted connection is already started');
        started = true;
        starts += 1;
        queueMicrotask(scheduleDrain);
      },
      completionBarrier() {
        const cutoff = lastAcceptedSequence;
        cutoffs.push(cutoff);
        const marker = new Promise<void>((resolve) => {
          inboundQueue.push({ kind: 'completion-marker', cutoff, resolve });
        });
        onCompletionBarrier?.(cutoff);
        if (started) scheduleDrain();
        return marker;
      },
    };
  };
  return {
    openConnection,
    queueInbound,
    setOnOutboundRequest(handler) { onOutboundRequest = handler; },
    setOnOutboundResponse(handler) { onOutboundResponse = handler; },
    setOnCompletionBarrier(handler) { onCompletionBarrier = handler; },
    rejectNextWrite(error) { nextWriteFailure = error; },
    resolveInboundFailure(value) { resolveInbound(value as Error); },
    rejectInboundFailure(reason) { rejectInbound(reason); },
    outboundRequests: () => requests.map((request) => ({ ...request })),
    outboundResponses: () => responses.map((response) => ({ ...response })),
    startCalls: () => starts,
    receiveCalls: () => receives,
    maxConcurrentReceive: () => maxReceives,
    barrierCutoffs: () => [...cutoffs],
    deliveredFrameSequences: () => [...deliveredSequences],
    waitForIdle: async () => {
      while (true) {
        const observedTail = drainTail;
        await observedTail;
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        if (observedTail === drainTail && inboundQueue.length === 0) return;
      }
    },
  };
}

type ScriptedLifecycleOptions = Readonly<{
  advertiseClose?: boolean;
  beforePromptResponse?(): void;
  afterPromptResponse?(): void;
}>;

function scriptSuccessfulLifecycle(
  peer: ScriptedPeer,
  sessionId: string,
  options: ScriptedLifecycleOptions = {},
): void {
  peer.setOnOutboundRequest((request) => {
    switch (request.method) {
      case 'initialize':
        peer.queueInbound(responseFor(request, {
          protocolVersion: 1,
          agentCapabilities: options.advertiseClose === false
            ? { sessionCapabilities: {} }
            : { sessionCapabilities: { close: {} } },
        }));
        return;
      case 'session/new':
        peer.queueInbound(responseFor(request, {
          sessionId,
          configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }],
        }));
        return;
      case 'session/set_config_option':
        peer.queueInbound(responseFor(request, {
          configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }],
        }));
        return;
      case 'session/prompt':
        peer.queueInbound({
          jsonrpc: '2.0', method: 'session/update', params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello from agent' } },
          },
        });
        peer.queueInbound({
          jsonrpc: '2.0', method: 'session/update', params: {
            sessionId,
            update: { sessionUpdate: 'usage_update', used: 5, size: 8, cost: { amount: 0.1, currency: 'USD' } },
          },
        });
        options.beforePromptResponse?.();
        peer.queueInbound(responseFor(request, { stopReason: 'end_turn' }));
        options.afterPromptResponse?.();
        return;
      case 'session/close':
        peer.queueInbound(responseFor(request, {}));
    }
  });
}

const REQUEST_ONE: AcpInvocationRequest = {
  cwd: '/repo/one', prompt: 'Implement one', clientInfo: { name: 'revo', version: '1.0.0' },
};
const REQUEST_TWO: AcpInvocationRequest = {
  cwd: '/repo/two', prompt: 'Implement two', clientInfo: { name: 'revo', version: '1.0.0' },
};

function dependenciesFor(
  peer: ScriptedPeer,
  diagnostics: AcpInvocationDiagnostic[] = [],
): AcpInvocationDependencies {
  return {
    openConnection: peer.openConnection,
    connector: {
      async configure({ session, setConfigOption }) {
        await setConfigOption({
          sessionId: session.sessionId,
          configId: 'thinking',
          type: 'boolean',
          value: true,
        });
      },
    },
    resolvePermission: async () => ({ outcome: 'cancel' }),
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); },
  };
}

function outboundResponse(peer: ScriptedPeer, id: number): JsonRpcResponse {
  const response = peer.outboundResponses().find((candidate) => candidate.id === id);
  assert.ok(response, `Expected outbound JSON-RPC response ${String(id)}`);
  return response;
}

function createActivationProbe(peer: ScriptedPeer): Readonly<{
  request: AcpInvocationRequest;
  deps: AcpInvocationDependencies;
  components: AcpInvocationComponents;
  events: string[];
}> {
  const events: string[] = [];
  const session = new AcpSession();
  const permissionHandler = new AcpPermissionRequestHandler();
  const outcomeCollector = new AcpPromptOutcomeCollector();
  const bindSession = session.bind.bind(session);
  const bindPermission = permissionHandler.bind.bind(permissionHandler);
  session.bind = (deps) => { events.push('session-bound'); bindSession(deps); };
  permissionHandler.bind = (deps) => { events.push('permission-bound'); bindPermission(deps); };
  const baseDeps = dependenciesFor(peer);
  return {
    request: REQUEST_ONE,
    components: { session, permissionHandler, outcomeCollector },
    events,
    deps: {
      ...baseDeps,
      async openConnection(handlers) {
        events.push('open');
        const opened = await peer.openConnection(handlers);
        const originalThen = opened.inboundFailure.then.bind(opened.inboundFailure);
        Object.defineProperty(opened.inboundFailure, 'then', {
          configurable: true,
          value(...args: Parameters<typeof originalThen>) {
            events.push('inbound-failure-consumed');
            return originalThen(...args);
          },
        });
        return { ...opened, start() { events.push('start'); opened.start(); } };
      },
    },
  };
}

test('runs one exact lifecycle through real JSON-RPC receive and correlation', async () => {
  const peer = createScriptedPeer();
  scriptSuccessfulLifecycle(peer, 'session-1');
  const outcome = await runInvocation(REQUEST_ONE, dependenciesFor(peer));
  await peer.waitForIdle();
  assert.deepEqual(peer.outboundRequests().map(({ method }) => method), [
    'initialize', 'session/new', 'session/set_config_option', 'session/prompt', 'session/close',
  ]);
  assert.equal(peer.startCalls(), 1);
  assert.equal(peer.maxConcurrentReceive(), 1);
  assert.deepEqual(outcome, {
    sessionId: 'session-1', text: 'hello from agent', stopReason: 'end_turn',
    usage: { used: 5, size: 8 }, reportedCost: { amount: 0.1, currency: 'USD' }, diagnostics: [],
  });
});

test('queues frames before start and drains only after activation', async () => {
  const peer = createScriptedPeer();
  let notifications = 0;
  const opened = await peer.openConnection({
    async onRequest() { return { kind: 'error', error: { code: -32601, message: 'Method not found' } }; },
    async onNotification() { notifications += 1; },
  });
  peer.queueInbound({ jsonrpc: '2.0', method: 'queued-before-start', params: {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peer.receiveCalls(), 0);
  assert.equal(notifications, 0);
  opened.start();
  await peer.waitForIdle();
  assert.equal(peer.receiveCalls(), 1);
  assert.equal(notifications, 1);
});

test('consumes inbound failure and binds components before one start', async () => {
  const peer = createScriptedPeer();
  scriptSuccessfulLifecycle(peer, 'session-activation');
  const probe = createActivationProbe(peer);
  await runAcpInvocationWithComponents(probe.request, probe.deps, probe.components);
  assert.deepEqual(probe.events.slice(0, 5), [
    'open', 'inbound-failure-consumed', 'session-bound', 'permission-bound', 'start',
  ]);
  assert.equal(peer.startCalls(), 1);
});

test('does not let a prompt response overtake the previous update', async () => {
  const peer = createScriptedPeer();
  scriptSuccessfulLifecycle(peer, 'session-fifo');
  const outcome = await runInvocation(REQUEST_ONE, dependenciesFor(peer));
  assert.equal(outcome.text, 'hello from agent');
  assert.equal(outcome.stopReason, 'end_turn');
  assert.equal(peer.maxConcurrentReceive(), 1);
});

test('rejects a failure accepted before the completion marker cutoff', async () => {
  const peer = createScriptedPeer();
  scriptSuccessfulLifecycle(peer, 'session-pre-marker', {
    afterPromptResponse() { peer.queueInbound({ jsonrpc: '2.0', id: 999, result: null }); },
  });
  await assert.rejects(runInvocation(REQUEST_ONE, dependenciesFor(peer)), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'unknown_response_id');
    return true;
  });
});

test('does not let a gated frame accepted after barrier invocation delay or fail the marker', async () => {
  const peer = createScriptedPeer();
  const diagnostics: AcpInvocationDiagnostic[] = [];
  let releasePostBarrierFrame!: () => void;
  const postBarrierGate = new Promise<void>((resolve) => { releasePostBarrierFrame = resolve; });
  scriptSuccessfulLifecycle(peer, 'session-post-marker', { advertiseClose: false });
  peer.setOnCompletionBarrier(() => {
    peer.queueInbound({ jsonrpc: '2.0', id: 999, result: null }, postBarrierGate);
  });
  const invocation = runInvocation(REQUEST_ONE, dependenciesFor(peer, diagnostics));
  const settled = await Promise.race([
    invocation.then((outcome) => ({ kind: 'outcome' as const, outcome })),
    new Promise<Readonly<{ kind: 'test-timeout' }>>((resolve) => {
      setTimeout(() => resolve({ kind: 'test-timeout' }), 50);
    }),
  ]);
  assert.equal(settled.kind, 'outcome');
  assert.deepEqual(peer.barrierCutoffs(), [6]);
  assert.deepEqual(peer.deliveredFrameSequences(), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(diagnostics, []);
  releasePostBarrierFrame();
  await peer.waitForIdle();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(peer.deliveredFrameSequences(), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(diagnostics.map(({ source, code }) => ({ source, code })), [{
    source: 'runtime', code: 'connection_failed_after_terminal',
  }]);
});

test('correlates exact ids and reports unknown and duplicate responses through receive', async () => {
  const unknownPeer = createScriptedPeer();
  const unknownOpened = await unknownPeer.openConnection({
    async onRequest() { return { kind: 'error', error: { code: -32601, message: 'Method not found' } }; },
    async onNotification() {},
  });
  unknownOpened.start();
  unknownPeer.queueInbound({ jsonrpc: '2.0', id: 999, result: null });
  assert.equal((await unknownOpened.inboundFailure as { code?: unknown }).code, 'unknown_response_id');

  const duplicatePeer = createScriptedPeer();
  const duplicateOpened = await duplicatePeer.openConnection({
    async onRequest() { return { kind: 'error', error: { code: -32601, message: 'Method not found' } }; },
    async onNotification() {},
  });
  duplicatePeer.setOnOutboundRequest((request) => {
    const response = responseFor(request, { ok: true });
    duplicatePeer.queueInbound(response);
    duplicatePeer.queueInbound(response);
  });
  duplicateOpened.start();
  assert.deepEqual(await duplicateOpened.connection.request('probe', {}), { ok: true });
  assert.equal((await duplicateOpened.inboundFailure as { code?: unknown }).code, 'duplicate_response_id');
});

test('keeps outbound write rejection on the request promise only', async () => {
  const peer = createScriptedPeer();
  const opened = await peer.openConnection({
    async onRequest() { return { kind: 'error', error: { code: -32601, message: 'Method not found' } }; },
    async onNotification() {},
  });
  opened.start();
  peer.rejectNextWrite(new Error('write failed'));
  await assert.rejects(opened.connection.request('probe', {}), (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'send_failed');
    return true;
  });
  const state = await Promise.race([
    opened.inboundFailure.then(() => 'settled', () => 'settled'),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ]);
  assert.equal(state, 'pending');
});

test('routes valid selected and cancelled permission requests through JSON-RPC responses', async () => {
  for (const scenario of [
    { id: 700, decision: { outcome: 'select' as const, optionKind: 'allow_once' as const }, expected: { outcome: 'selected', optionId: 'allow' } },
    { id: 701, decision: { outcome: 'cancel' as const }, expected: { outcome: 'cancelled' } },
  ]) {
    const peer = createScriptedPeer();
    let resolverCalls = 0;
    const deps: AcpInvocationDependencies = {
      ...dependenciesFor(peer),
      resolvePermission: async () => { resolverCalls += 1; return scenario.decision; },
    };
    scriptSuccessfulLifecycle(peer, `session-request-${String(scenario.id)}`, {
      advertiseClose: false,
      beforePromptResponse() {
      peer.queueInbound({
        jsonrpc: '2.0', id: scenario.id, method: 'session/request_permission', params: {
          sessionId: `session-request-${String(scenario.id)}`,
          toolCall: { toolCallId: 'tool-1' },
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        },
      });
      },
    });
    const invocation = runInvocation(REQUEST_ONE, deps);
    await invocation;
    await peer.waitForIdle();
    assert.deepEqual(outboundResponse(peer, scenario.id), {
      jsonrpc: '2.0', id: scenario.id, result: { outcome: scenario.expected },
    });
    assert.equal(resolverCalls, 1);
  }
});

test('returns exact protocol errors for malformed and unknown peer requests', async () => {
  const peer = createScriptedPeer();
  const opened = await peer.openConnection({
    async onRequest(request) {
      if (request.method === 'bad') return { kind: 'error', error: { code: -32602, message: 'Invalid params' } };
      return { kind: 'error', error: { code: -32601, message: 'Method not found' } };
    },
    async onNotification() {},
  });
  opened.start();
  peer.queueInbound({ jsonrpc: '2.0', id: 710, method: 'bad', params: {} });
  peer.queueInbound({ jsonrpc: '2.0', id: 711, method: 'unknown', params: {} });
  await peer.waitForIdle();
  assert.deepEqual(outboundResponse(peer, 710), { jsonrpc: '2.0', id: 710, error: { code: -32602, message: 'Invalid params' } });
  assert.deepEqual(outboundResponse(peer, 711), { jsonrpc: '2.0', id: 711, error: { code: -32601, message: 'Method not found' } });
});

test('routes malformed and unknown requests through runtime and latches their exact protocol failures', async () => {
  for (const scenario of [
    { id: 720, method: 'session/request_permission', params: {}, code: -32602, message: 'Invalid params', failure: 'malformed_peer_request' },
    { id: 721, method: 'peer/unknown', params: {}, code: -32601, message: 'Method not found', failure: 'unsupported_peer_request' },
  ] as const) {
    const peer = createScriptedPeer();
    let resolverCalls = 0;
    scriptSuccessfulLifecycle(peer, `session-protocol-${String(scenario.id)}`, {
      beforePromptResponse() {
        peer.queueInbound({ jsonrpc: '2.0', id: scenario.id, method: scenario.method, params: scenario.params });
      },
    });
    await assert.rejects(runInvocation(REQUEST_ONE, {
      ...dependenciesFor(peer),
      resolvePermission: async () => { resolverCalls += 1; return { outcome: 'cancel' }; },
    }), (error: unknown) => (error as { code?: unknown }).code === scenario.failure);
    await peer.waitForIdle();
    assert.deepEqual(outboundResponse(peer, scenario.id), {
      jsonrpc: '2.0', id: scenario.id, error: { code: scenario.code, message: scenario.message },
    });
    assert.equal(resolverCalls, 0);
  }
});

test('returns internal error for an unexpected permission handler throw and latches the original failure', async () => {
  const peer = createScriptedPeer();
  const failure = new Error('unexpected permission handler failure');
  const components: AcpInvocationComponents = {
    session: new AcpSession(),
    permissionHandler: new AcpPermissionRequestHandler(),
    outcomeCollector: new AcpPromptOutcomeCollector(),
  };
  components.permissionHandler.handle = async () => { throw failure; };
  scriptSuccessfulLifecycle(peer, 'session-handler-throw', {
    beforePromptResponse() { peer.queueInbound(permissionRequest(725, 'session-handler-throw')); },
  });
  await assert.rejects(
    runAcpInvocationWithComponents(REQUEST_ONE, dependenciesFor(peer), components),
    (error) => error === failure,
  );
  await peer.waitForIdle();
  assert.deepEqual(outboundResponse(peer, 725), {
    jsonrpc: '2.0', id: 725, error: { code: -32603, message: 'Internal error' },
  });
});

test('cancels before-session, foreign-session, and post-terminal permissions without resolver calls', async () => {
  for (const phase of ['before', 'foreign', 'terminal'] as const) {
    const expectedCode = {
      before: 'permission_request_before_session',
      foreign: 'foreign_session_request',
      terminal: 'permission_request_after_terminal',
    }[phase];
    const peer = createScriptedPeer();
    const id = phase === 'before' ? 730 : phase === 'foreign' ? 731 : 732;
    const sessionId = `session-permission-${phase}`;
    let resolverCalls = 0;
    peer.setOnOutboundRequest((request) => {
      if (request.method === 'initialize') {
        if (phase === 'before') peer.queueInbound(permissionRequest(id, sessionId));
        peer.queueInbound(responseFor(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } }));
      } else if (request.method === 'session/new') {
        peer.queueInbound(responseFor(request, { sessionId, configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }] }));
      } else if (request.method === 'session/set_config_option') {
        peer.queueInbound(responseFor(request, { configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] }));
      } else if (request.method === 'session/prompt') {
        if (phase === 'foreign') peer.queueInbound(permissionRequest(id, 'foreign-session'));
        peer.queueInbound(responseFor(request, { stopReason: 'end_turn' }));
        if (phase === 'terminal') peer.queueInbound(permissionRequest(id, sessionId));
      }
    });
    await assert.rejects(
      runInvocation(REQUEST_ONE, {
        ...dependenciesFor(peer),
        resolvePermission: async () => { resolverCalls += 1; return { outcome: 'cancel' }; },
      }),
      (error) => {
        assert.equal((error as { code?: unknown }).code, expectedCode);
        return true;
      },
    );
    await peer.waitForIdle();
    assert.deepEqual(outboundResponse(peer, id), {
      jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } },
    });
    assert.equal(resolverCalls, 0);
  }
});

function permissionRequest(id: number, sessionId: string): JsonRpcRequest {
  return {
    jsonrpc: '2.0', id, method: 'session/request_permission', params: {
      sessionId,
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    },
  };
}

test('rejects malformed, unsupported, foreign, and post-terminal notifications without responses', async () => {
  for (const scenario of ['malformed', 'unsupported', 'foreign', 'terminal'] as const) {
    const expectedCode = {
      malformed: 'malformed_peer_notification',
      unsupported: 'unsupported_peer_notification',
      foreign: 'foreign_session_update',
      terminal: 'session_update_after_terminal',
    }[scenario];
    const peer = createScriptedPeer();
    const sessionId = `session-notification-${scenario}`;
    scriptSuccessfulLifecycle(peer, sessionId, {
      beforePromptResponse() {
        if (scenario === 'malformed') {
          peer.queueInbound({ jsonrpc: '2.0', method: 'session/update', params: {} });
        } else if (scenario === 'unsupported') {
          peer.queueInbound({ jsonrpc: '2.0', method: 'peer/unknown', params: {} });
        } else if (scenario === 'foreign') {
          peer.queueInbound({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'bad' } },
          } });
        }
      },
      afterPromptResponse() {
        if (scenario === 'terminal') peer.queueInbound({
          jsonrpc: '2.0', method: 'session/update', params: {
            sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
          },
        });
      },
    });
    await assert.rejects(
      runInvocation(REQUEST_ONE, dependenciesFor(peer)),
      (error) => {
        assert.equal((error as { code?: unknown }).code, expectedCode);
        return true;
      },
    );
    assert.deepEqual(peer.outboundResponses(), []);
  }
});

test('preserves the first inbound failure across initialize, create, configure, and prompt', async () => {
  for (const method of ['initialize', 'session/new', 'session/set_config_option', 'session/prompt'] as const) {
    const peer = createScriptedPeer();
    const first = new Error(`failed during ${method}`);
    peer.setOnOutboundRequest((request) => {
      if (request.method === method) { peer.resolveInboundFailure(first); return; }
      if (request.method === 'initialize') peer.queueInbound(responseFor(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } }));
      if (request.method === 'session/new') peer.queueInbound(responseFor(request, { sessionId: `session-failure-${method}`, configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }] }));
      if (request.method === 'session/set_config_option') peer.queueInbound(responseFor(request, { configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] }));
    });
    await assert.rejects(runInvocation(REQUEST_ONE, dependenciesFor(peer)), (error) => error === first);
    peer.rejectInboundFailure(new Error('second failure'));
  }
});

test('preserves rejected inbound failures in every lifecycle phase without unhandled rejections', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const method of ['initialize', 'session/new', 'session/set_config_option', 'session/prompt'] as const) {
      const peer = createScriptedPeer();
      const first = new Error(`rejected during ${method}`);
      const second = new Error(`second rejection during ${method}`);
      peer.setOnOutboundRequest((request) => {
        if (request.method === method) {
          peer.rejectInboundFailure(first);
          peer.resolveInboundFailure(second);
          return;
        }
        if (request.method === 'initialize') peer.queueInbound(responseFor(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } }));
        if (request.method === 'session/new') peer.queueInbound(responseFor(request, { sessionId: `session-rejection-${method}`, configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }] }));
        if (request.method === 'session/set_config_option') peer.queueInbound(responseFor(request, { configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] }));
      });
      await assert.rejects(runInvocation(REQUEST_ONE, dependenciesFor(peer)), (error) => error === first);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('keeps invocation outbound request rejection primary over a later inbound failure', async () => {
  const peer = createScriptedPeer();
  const inboundFailure = new Error('later inbound failure');
  peer.rejectNextWrite(new Error('initialize write failed'));
  const invocation = runInvocation(REQUEST_ONE, dependenciesFor(peer));
  queueMicrotask(() => peer.rejectInboundFailure(inboundFailure));
  await assert.rejects(invocation, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, 'send_failed');
    return true;
  });
});

test('rejects duplicate prompt response and out-of-order post-response update before the marker', async () => {
  for (const scenario of ['duplicate-response', 'post-response-update'] as const) {
    const peer = createScriptedPeer();
    const sessionId = `session-order-${scenario}`;
    scriptSuccessfulLifecycle(peer, sessionId, {
      afterPromptResponse() {
        const prompt = peer.outboundRequests().find(({ method }) => method === 'session/prompt');
        assert.ok(prompt);
        if (scenario === 'duplicate-response') {
          peer.queueInbound(responseFor(prompt, { stopReason: 'end_turn' }));
        } else {
          peer.queueInbound({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } },
          } });
        }
      },
    });
    await assert.rejects(runInvocation(REQUEST_ONE, dependenciesFor(peer)), (error: unknown) => {
      assert.equal((error as { code?: unknown }).code,
        scenario === 'duplicate-response' ? 'duplicate_response_id' : 'session_update_after_terminal');
      return true;
    });
  }
});

test('keeps connector rejection primary and schedules close without prompting', async () => {
  const peer = createScriptedPeer();
  const failure = new Error('connector failed');
  scriptSuccessfulLifecycle(peer, 'session-connector');
  await assert.rejects(runInvocation(REQUEST_ONE, {
    ...dependenciesFor(peer), connector: { async configure() { throw failure; } },
  }), (error) => error === failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(peer.outboundRequests().some(({ method }) => method === 'session/prompt'), false);
  assert.equal(peer.outboundRequests().filter(({ method }) => method === 'session/close').length, 1);
});

test('normalizes Error to bounded data without live error fields', () => {
  const source = new Error('boom', { cause: new Error('secret') });
  const details = normalizeAcpDiagnosticDetails(source);
  assert.deepEqual(details, { name: 'Error', message: 'boom' });
  assert.equal(Object.hasOwn(details as object, 'stack'), false);
  assert.equal(Object.hasOwn(details as object, 'cause'), false);
  assert.ok(Object.isFrozen(details));
});

test('does not invoke getters, inherited fields or toJSON', () => {
  let calls = 0;
  const source = Object.create({ inherited: 'secret' }) as Record<string, unknown>;
  Object.defineProperty(source, 'getter', {
    enumerable: true, get() { calls += 1; throw new Error('getter'); },
  });
  Object.defineProperty(source, 'toJSON', {
    enumerable: true, value() { calls += 1; return { secret: true }; },
  });
  const details = normalizeAcpDiagnosticDetails(source);
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(details).includes('secret'), false);
});

test('normalizes the exact bounded diagnostic matrix and freezes recursive snapshots', () => {
  assert.deepEqual(normalizeAcpDiagnosticDetails(Number.POSITIVE_INFINITY), {
    kind: 'non_finite_number', value: 'Infinity',
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.deepEqual(normalizeAcpDiagnosticDetails(cycle), { self: { kind: 'truncated', reason: 'cycle' } });
  const depthFive = { one: { two: { three: { four: { five: true } } } } };
  assert.deepEqual(normalizeAcpDiagnosticDetails(depthFive), {
    one: { two: { three: { four: { kind: 'truncated', reason: 'depth' } } } },
  });
  const thirtyThreeEntries = Object.fromEntries(
    Array.from({ length: 33 }, (_, index) => [`key-${String(index)}`, index]),
  );
  assert.deepEqual(normalizeAcpDiagnosticDetails(thirtyThreeEntries), { kind: 'truncated', reason: 'entries' });
  assert.deepEqual(normalizeAcpDiagnosticDetails('x'.repeat(513)), { kind: 'truncated', reason: 'string' });
  assert.deepEqual(normalizeAcpDiagnosticDetails(1n), { kind: 'unsupported', type: 'bigint' });
  const source = { z: [{ b: 2 }], a: 1 };
  const normalized = normalizeAcpDiagnosticDetails(source);
  assert.deepEqual(normalized, { a: 1, z: [{ b: 2 }] });
  assert.deepEqual(Object.keys(normalized as object), ['a', 'z']);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen((normalized as { z: readonly unknown[] }).z));
  assert.ok(Object.isFrozen((normalized as { z: readonly object[] }).z[0]));
  source.z[0]!.b = 9;
  assert.deepEqual(normalized, { a: 1, z: [{ b: 2 }] });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.deepEqual(normalizeAcpDiagnosticDetails(revoked.proxy), { kind: 'unsupported', type: 'uninspectable' });
});

test('rejects hostile sparse, accessor, extra-key, symbol-key, and oversized arrays', () => {
  const sparse = new Array(1);
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { throw new Error('must not run'); } });
  Object.defineProperty(accessor, 'length', { value: 1 });
  const extraKey = [1];
  Object.defineProperty(extraKey, 'extra', { enumerable: true, value: 2 });
  const symbolKey = [1];
  Object.defineProperty(symbolKey, Symbol('secret'), { enumerable: true, value: 2 });
  assert.deepEqual(normalizeAcpDiagnosticDetails(sparse), { kind: 'unsupported', type: 'array' });
  assert.deepEqual(normalizeAcpDiagnosticDetails(accessor), { kind: 'unsupported', type: 'array' });
  assert.deepEqual(normalizeAcpDiagnosticDetails(extraKey), { kind: 'unsupported', type: 'array' });
  assert.deepEqual(normalizeAcpDiagnosticDetails(symbolKey), { kind: 'unsupported', type: 'array' });
  assert.deepEqual(normalizeAcpDiagnosticDetails(Array.from({ length: 33 }, (_, index) => index)), {
    kind: 'truncated', reason: 'entries',
  });
});

test('consumes hostile inbound resolve and reject values without coercion or unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const throwingProxy = new Proxy({}, {
      getPrototypeOf() { throw new Error('prototype trap must be contained'); },
    });
    const coercive = {
      [Symbol.toPrimitive]() { throw new Error('coercion must not execute'); },
      toString() { throw new Error('toString must not execute'); },
    };
    const resolvedPeer = createScriptedPeer();
    const resolved = runInvocation(REQUEST_ONE, dependenciesFor(resolvedPeer));
    resolvedPeer.resolveInboundFailure(throwingProxy);
    await assert.rejects(resolved, /ACP operation failed with a non-Error value/);
    const rejectedPeer = createScriptedPeer();
    const rejected = runInvocation(REQUEST_TWO, dependenciesFor(rejectedPeer));
    rejectedPeer.rejectInboundFailure(coercive);
    await assert.rejects(rejected, /ACP operation failed with a non-Error value/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('rejects open and synchronous start failures with exact cleanup boundaries', async () => {
  const openFailure = new Error('open failed');
  let bound = 0;
  const components: AcpInvocationComponents = {
    session: new AcpSession(), permissionHandler: new AcpPermissionRequestHandler(), outcomeCollector: new AcpPromptOutcomeCollector(),
  };
  const originalBind = components.session.bind.bind(components.session);
  components.session.bind = (deps) => { bound += 1; originalBind(deps); };
  await assert.rejects(runAcpInvocationWithComponents(REQUEST_ONE, {
    ...dependenciesFor(createScriptedPeer()),
    async openConnection() { throw openFailure; },
  }, components), (error) => error === openFailure);
  assert.equal(bound, 0);

  const peer = createScriptedPeer();
  const startFailure = new Error('start failed');
  let starts = 0;
  let closeCalls = 0;
  const startComponents: AcpInvocationComponents = {
    session: new AcpSession(), permissionHandler: new AcpPermissionRequestHandler(), outcomeCollector: new AcpPromptOutcomeCollector(),
  };
  const close = startComponents.session.close.bind(startComponents.session);
  startComponents.session.close = () => { closeCalls += 1; return close(); };
  await assert.rejects(runAcpInvocationWithComponents(REQUEST_ONE, {
    ...dependenciesFor(peer),
    async openConnection(handlers) {
      const opened = await peer.openConnection(handlers);
      return { ...opened, start() { starts += 1; throw startFailure; } };
    },
  }, startComponents), (error) => error === startFailure);
  assert.equal(starts, 1);
  assert.equal(closeCalls, 1);
  assert.equal(peer.outboundRequests().filter(({ method }) => method === 'session/close').length, 0);
});

test('reports exactly one observer throw diagnostic and isolates the diagnostic callback', async () => {
  const peer = createScriptedPeer();
  const diagnostics: AcpInvocationDiagnostic[] = [];
  scriptSuccessfulLifecycle(peer, 'session-observer', { advertiseClose: false });
  let observerCalls = 0;
  const outcome = await runInvocation(REQUEST_ONE, {
    ...dependenciesFor(peer, diagnostics),
    onSessionUpdate() { observerCalls += 1; if (observerCalls === 1) throw new Error('observer failed'); },
    onDiagnostic(diagnostic) { diagnostics.push(diagnostic); throw new Error('diagnostic observer failed'); },
  });
  assert.equal(observerCalls, 2);
  assert.equal(outcome.text, 'hello from agent');
  assert.deepEqual(diagnostics.map(({ source, code }) => ({ source, code })), [
    { source: 'runtime', code: 'session_update_observer_failed' },
  ]);
});

test('reports one late inbound failure without mutating the returned outcome', async () => {
  const peer = createScriptedPeer();
  const diagnostics: AcpInvocationDiagnostic[] = [];
  scriptSuccessfulLifecycle(peer, 'session-late', { advertiseClose: false });
  const outcome = await runInvocation(REQUEST_ONE, dependenciesFor(peer, diagnostics));
  const snapshot = structuredClone(outcome);
  peer.resolveInboundFailure(new Error('late read failed'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(outcome, snapshot);
  assert.deepEqual(diagnostics.map(({ source, code }) => ({ source, code })), [
    { source: 'runtime', code: 'connection_failed_after_terminal' },
  ]);
});

test('reports exact close failures and does not await null, rejecting, malformed, or hanging close', async () => {
  for (const closeMode of ['null', 'reject', 'malformed', 'hang'] as const) {
    const peer = createScriptedPeer();
    const diagnostics: AcpInvocationDiagnostic[] = [];
    scriptSuccessfulLifecycle(peer, `session-close-${closeMode}`, { advertiseClose: closeMode !== 'null' });
    if (closeMode !== 'null') {
      peer.setOnOutboundRequest((request) => {
        if (request.method === 'initialize') {
          peer.queueInbound(responseFor(request, { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } }));
        } else if (request.method === 'session/new') {
          peer.queueInbound(responseFor(request, { sessionId: `session-close-${closeMode}`, configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }] }));
        } else if (request.method === 'session/set_config_option') {
          peer.queueInbound(responseFor(request, { configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] }));
        } else if (request.method === 'session/prompt') {
          peer.queueInbound(responseFor(request, { stopReason: 'end_turn' }));
          if (closeMode === 'reject') peer.rejectNextWrite(new Error('close write failed'));
        } else if (request.method === 'session/close') {
          if (closeMode === 'malformed') peer.queueInbound(responseFor(request, { _meta: 1 }));
        }
      });
    } else {
      peer.setOnOutboundRequest((request) => {
        if (request.method === 'initialize') {
          peer.queueInbound(responseFor(request, {
            protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: null } },
          }));
        } else if (request.method === 'session/new') {
          peer.queueInbound(responseFor(request, { sessionId: 'session-close-null', configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: false }] }));
        } else if (request.method === 'session/set_config_option') {
          peer.queueInbound(responseFor(request, { configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] }));
        } else if (request.method === 'session/prompt') {
          peer.queueInbound(responseFor(request, { stopReason: 'end_turn' }));
        }
      });
    }
    const invocation = runInvocation(REQUEST_ONE, dependenciesFor(peer, diagnostics));
    const result = await Promise.race([
      invocation.then((outcome) => ({ kind: 'outcome' as const, outcome })),
      new Promise<Readonly<{ kind: 'test-timeout' }>>((resolve) => {
        setTimeout(() => resolve({ kind: 'test-timeout' }), 50);
      }),
    ]);
    assert.equal(result.kind, 'outcome');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const closeCalls = peer.outboundRequests().filter(({ method }) => method === 'session/close').length;
    assert.equal(closeCalls, closeMode === 'null' || closeMode === 'reject' ? 0 : 1);
    assert.equal(diagnostics.some(({ source, code }) => source === 'runtime' && code === 'connection_failed_after_terminal'), false);
    const closeDiagnostics = diagnostics.filter(({ source, code }) => source === 'session' && code === 'close_failed');
    assert.equal(closeDiagnostics.length, closeMode === 'reject' || closeMode === 'malformed' ? 1 : 0);
    if (closeDiagnostics.length === 1) {
      assert.equal(closeDiagnostics[0]!.message, 'ACP session close failed');
    }
  }
});

test('keeps two concurrent invocation states isolated', async () => {
  const first = createScriptedPeer();
  const second = createScriptedPeer();
  const firstDiagnostics: AcpInvocationDiagnostic[] = [];
  const secondDiagnostics: AcpInvocationDiagnostic[] = [];
  scriptSuccessfulLifecycle(first, 'session-concurrent-one', { advertiseClose: false });
  scriptSuccessfulLifecycle(second, 'session-concurrent-two', { advertiseClose: false });
  const [firstOutcome, secondOutcome] = await Promise.all([
    runInvocation(REQUEST_ONE, dependenciesFor(first, firstDiagnostics)),
    runInvocation(REQUEST_TWO, dependenciesFor(second, secondDiagnostics)),
  ]);
  first.resolveInboundFailure(new Error('late first failure'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstOutcome.sessionId, 'session-concurrent-one');
  assert.equal(secondOutcome.sessionId, 'session-concurrent-two');
  assert.equal(firstDiagnostics.length, 1);
  assert.deepEqual(secondDiagnostics, []);
});

test('exposes terminal outcome unavailable as an exact invocation error', async () => {
  const peer = createScriptedPeer();
  scriptSuccessfulLifecycle(peer, 'session-unavailable', { advertiseClose: false });
  const collector = new AcpPromptOutcomeCollector();
  collector.outcome = () => ({ outcome: 'unavailable', reason: 'terminal-not-received' });
  await assert.rejects(runAcpInvocationWithComponents(REQUEST_ONE, dependenciesFor(peer), {
    session: new AcpSession(), permissionHandler: new AcpPermissionRequestHandler(), outcomeCollector: collector,
  }), (error: unknown) => error instanceof AcpInvocationError && error.code === 'terminal_outcome_unavailable');
});
