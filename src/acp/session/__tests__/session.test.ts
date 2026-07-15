import assert from 'node:assert/strict';
import test from 'node:test';
import type { JsonRpcConnection } from '../../jsonrpc/connection.types.js';
import type { JsonRpcParams, JsonRpcValue } from '../../jsonrpc/types.js';
import { ACP_METHODS } from '../../protocol/methods.js';
import { parseAcpPeerNotification } from '../../protocol/parser.js';
import type {
  AcpInitializeRequest,
  AcpPermissionRequest,
  AcpSessionNotification,
} from '../../protocol/values.js';
import { AcpSessionError } from '../error.js';
import { AcpSession, createAcpSession } from '../session.js';
import type {
  AcpSessionDependencies,
  AcpSessionFailureCode,
} from '../types.js';

type RecordedRequest = Readonly<{ method: string; params: JsonRpcParams | undefined }>;
type RecordingConnection = JsonRpcConnection & Readonly<{ requests: RecordedRequest[] }>;

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function createRecordingConnection(
  responses: Partial<Record<string, JsonRpcValue | Promise<JsonRpcValue>>> = {},
): RecordingConnection {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    request(method, params) {
      requests.push({ method, params });
      const response = responses[method];
      if (!Object.hasOwn(responses, method) || response === undefined) {
        return Promise.reject(new Error(`missing ${method}`));
      }
      return Promise.resolve(response);
    },
    async notify() {},
    async receive() {},
    close() {},
  };
}

function hasSessionCode(code: AcpSessionFailureCode) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AcpSessionError);
    assert.equal(error.code, code);
    return true;
  };
}

const INITIALIZE_REQUEST: AcpInitializeRequest = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    session: { configOptions: { boolean: {} } },
    terminal: false,
  },
  clientInfo: { name: 'revo', version: '1' },
};

const SESSION_DEPENDENCIES: AcpSessionDependencies = {
  connection: createRecordingConnection(),
  async onUpdate() {},
  onDiagnostic() {},
};

function sessionWith(
  responses: Partial<Record<string, JsonRpcValue | Promise<JsonRpcValue>>>,
  overrides: Partial<AcpSessionDependencies> = {},
) {
  const connection = createRecordingConnection(responses);
  return {
    connection,
    session: createAcpSession({
      connection,
      async onUpdate() {},
      onDiagnostic() {},
      ...overrides,
    }),
  };
}

function initializeRequestWithoutAdvertisedBoolean(): AcpInitializeRequest {
  return {
    ...INITIALIZE_REQUEST,
    clientCapabilities: {
      ...INITIALIZE_REQUEST.clientCapabilities,
      session: { configOptions: {} },
    },
  } as AcpInitializeRequest;
}

async function createSession(
  session: ReturnType<typeof createAcpSession>,
  request: AcpInitializeRequest = INITIALIZE_REQUEST,
): Promise<string> {
  await session.initialize(request);
  return (await session.create({ cwd: '/repo', mcpServers: [] })).sessionId;
}

const PERMISSION_REQUEST: AcpPermissionRequest = {
  sessionId: 'session-A',
  toolCall: { toolCallId: 'tool-1' },
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
};

test('requires dependencies before the first lifecycle operation', async () => {
  const session = new AcpSession();
  await assert.rejects(session.initialize(INITIALIZE_REQUEST), hasSessionCode('dependencies_not_bound'));
});

test('binds dependencies exactly once', () => {
  const session = new AcpSession();
  session.bind(SESSION_DEPENDENCIES);
  assert.throws(() => session.bind(SESSION_DEPENDENCIES), hasSessionCode('dependencies_already_bound'));
});

test('routes explicit lifecycle requests through exact builders and parsers', async () => {
  const { session, connection } = sessionWith({
    initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    'session/new': { sessionId: 'session-A' },
    'session/set_config_option': { configOptions: [] },
    'session/prompt': { stopReason: 'end_turn' },
    'session/close': {},
  });
  const initialization = await session.initialize(INITIALIZE_REQUEST);
  const created = await session.create({ cwd: '/repo', mcpServers: [] });
  await session.configure(async () => {
    assert.deepEqual(await session.setConfigOption({
      sessionId: created.sessionId,
      configId: 'thinking',
      type: 'boolean',
      value: true,
    }), { configOptions: [] });
  });
  assert.deepEqual(await session.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
  }), { stopReason: 'end_turn' });
  assert.equal(initialization.protocolVersion, 1);
  assert.deepEqual(connection.requests.slice(0, 4), [
    { method: ACP_METHODS.initialize, params: INITIALIZE_REQUEST },
    { method: ACP_METHODS.newSession, params: { cwd: '/repo', mcpServers: [] } },
    { method: ACP_METHODS.setSessionConfigOption, params: { sessionId: 'session-A', configId: 'thinking', type: 'boolean', value: true } },
    { method: ACP_METHODS.prompt, params: { sessionId: 'session-A', prompt: [{ type: 'text', text: 'hello' }] } },
  ]);
});

test('derives boolean option support only from client capabilities', async () => {
  const hostile = initializeRequestWithoutAdvertisedBoolean();
  const { connection, session: unsupported } = sessionWith({
    initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    'session/new': { sessionId: 'session-A', configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] },
  });
  await unsupported.initialize(hostile);
  assert.deepEqual(connection.requests[0], { method: ACP_METHODS.initialize, params: hostile });
  await assert.rejects(unsupported.create({ cwd: '/repo', mcpServers: [] }), hasSessionCode('failed'));

  const supported = sessionWith({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'session-A', configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] },
  }).session;
  await supported.initialize(INITIALIZE_REQUEST);
  assert.equal((await supported.create({ cwd: '/repo', mcpServers: [] })).sessionId, 'session-A');
});

test('accepts only typed config update options supported by the client', async () => {
  const received: AcpSessionNotification[] = [];
  const valid = sessionWith({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: 'session-A' } }, {
    async onUpdate(notification) { received.push(notification); },
  }).session;
  await createSession(valid);
  const notification = parseAcpPeerNotification({
    method: ACP_METHODS.sessionUpdate,
    params: {
      sessionId: 'session-A',
      update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true }] },
    },
  });
  await valid.receiveUpdate(notification);
  assert.deepEqual(received, [notification]);

  let routed = false;
  const unsupported = sessionWith({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: 'session-A' } }, {
    async onUpdate() { routed = true; },
  }).session;
  const hostile = initializeRequestWithoutAdvertisedBoolean();
  await createSession(unsupported, hostile);
  await assert.rejects(unsupported.receiveUpdate(notification), hasSessionCode('failed'));
  assert.equal(routed, false);
});

test('enforces lifecycle and exact session cardinality without extra wire calls', async () => {
  const { session, connection } = sessionWith({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'session-A' },
    'session/set_config_option': { configOptions: [] },
    'session/prompt': { stopReason: 'end_turn' },
  });
  await assert.rejects(session.create({ cwd: '/repo', mcpServers: [] }), hasSessionCode('session_new_already_started'));
  await assert.rejects(session.configure(async () => {}), hasSessionCode('configuration_before_session'));
  await assert.rejects(session.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('prompt_before_session'));
  assert.throws(() => session.assertPermissionRequest(PERMISSION_REQUEST), hasSessionCode('permission_request_before_session'));
  const initialization = session.initialize(INITIALIZE_REQUEST);
  await assert.rejects(session.initialize(INITIALIZE_REQUEST), hasSessionCode('initialize_already_started'));
  await initialization;
  const creation = session.create({ cwd: '/repo', mcpServers: [] });
  await assert.rejects(session.create({ cwd: '/repo', mcpServers: [] }), hasSessionCode('session_new_already_started'));
  await creation;
  await assert.rejects(session.setConfigOption({ sessionId: 'session-A', configId: 'x', value: 'y' }), hasSessionCode('set_config_option_outside_configuration'));
  await session.configure(async () => {
    await assert.rejects(session.configure(async () => {}), hasSessionCode('configuration_already_started'));
    const before = connection.requests.length;
    await assert.rejects(session.setConfigOption({ sessionId: 'foreign', configId: 'x', value: 'y' }), hasSessionCode('foreign_session_config_option'));
    assert.equal(connection.requests.length, before);
  });
  const before = connection.requests.length;
  await assert.rejects(session.prompt({ sessionId: 'foreign', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('foreign_session_prompt'));
  assert.equal(connection.requests.length, before);
  const prompting = session.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] });
  await assert.rejects(session.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('prompt_already_started'));
  await prompting;
  assert.throws(() => session.assertPermissionRequest({ ...PERMISSION_REQUEST, sessionId: 'foreign' }), hasSessionCode('foreign_session_request'));
});

test('fails on unexpected and foreign updates before onUpdate', async () => {
  let routed = 0;
  const early = sessionWith({}, { async onUpdate() { routed += 1; } }).session;
  await assert.rejects(early.receiveUpdate({ sessionId: 'session-A', update: { kind: 'agent-text', text: 'x' } }), hasSessionCode('unexpected_update'));
  assert.equal(routed, 0);

  const established = sessionWith({ initialize: { protocolVersion: 1 }, 'session/new': { sessionId: 'session-A' } }, {
    async onUpdate() { routed += 1; },
  }).session;
  await createSession(established);
  await assert.rejects(established.receiveUpdate({ sessionId: 'foreign', update: { kind: 'agent-text', text: 'x' } }), hasSessionCode('foreign_session_update'));
  assert.equal(routed, 0);
  await assert.rejects(established.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('failed'));
});

test('sends one capability-gated parsed close and shares its operation', async () => {
  const closeGate = deferred<JsonRpcValue>();
  const { session, connection } = sessionWith({
    initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    'session/new': { sessionId: 'session-A' },
    'session/close': closeGate.promise,
  });
  await createSession(session);
  const first = session.close();
  const second = session.close();
  assert.strictEqual(first, second);
  assert.deepEqual(connection.requests.at(-1), { method: ACP_METHODS.closeSession, params: { sessionId: 'session-A' } });
  closeGate.resolve({});
  await first;
  assert.equal(connection.requests.filter(({ method }) => method === ACP_METHODS.closeSession).length, 1);
});

test('closes locally without wire or diagnostics when close is absent or null', async () => {
  for (const agentCapabilities of [undefined, { sessionCapabilities: { close: null } }]) {
    const diagnostics: string[] = [];
    const { session, connection } = sessionWith({
      initialize: { protocolVersion: 1, ...(agentCapabilities === undefined ? {} : { agentCapabilities }) },
      'session/new': { sessionId: 'session-A' },
    }, { onDiagnostic(diagnostic) { diagnostics.push(diagnostic.code); } });
    await createSession(session);
    await session.close();
    assert.equal(connection.requests.some(({ method }) => method === ACP_METHODS.closeSession), false);
    assert.deepEqual(diagnostics, []);
    await assert.rejects(session.initialize(INITIALIZE_REQUEST), hasSessionCode('closed'));
  }
});

test('suppresses rejected and malformed close with one diagnostic', async () => {
  for (const closeResponse of [Promise.reject(new Error('close failed')), { _meta: 1 }]) {
    void Promise.resolve(closeResponse).catch(() => {});
    const diagnostics: string[] = [];
    const { session } = sessionWith({
      initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
      'session/new': { sessionId: 'session-A' },
      'session/close': closeResponse,
    }, { onDiagnostic(diagnostic) { diagnostics.push(diagnostic.code); } });
    await createSession(session);
    await session.close();
    assert.deepEqual(diagnostics, ['close_failed']);
  }
});

test('close during initialize never reopens or sends close', async () => {
  const gate = deferred<JsonRpcValue>();
  const { session, connection } = sessionWith({ initialize: gate.promise });
  const initializing = session.initialize(INITIALIZE_REQUEST);
  const closing = session.close();
  gate.resolve({ protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } });
  await initializing;
  await closing;
  assert.deepEqual(connection.requests.map(({ method }) => method), [ACP_METHODS.initialize]);
  await assert.rejects(session.create({ cwd: '/repo', mcpServers: [] }), hasSessionCode('closed'));
});

test('close during session/new waits for its ID and sends at most one close', async () => {
  const createGate = deferred<JsonRpcValue>();
  const { session, connection } = sessionWith({
    initialize: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {} } } },
    'session/new': createGate.promise,
    'session/close': {},
  });
  await session.initialize(INITIALIZE_REQUEST);
  const creating = session.create({ cwd: '/repo', mcpServers: [] });
  const closing = session.close();
  createGate.resolve({ sessionId: 'session-A' });
  await creating;
  await closing;
  assert.equal(connection.requests.filter(({ method }) => method === ACP_METHODS.closeSession).length, 1);
  await assert.rejects(session.configure(async () => {}), hasSessionCode('closed'));
});

test('close during configuration preserves its primary settle result and never reopens', async () => {
  for (const failure of [undefined, new Error('configuration failed')]) {
    const gate = deferred<void>();
    const { session } = sessionWith({
      initialize: { protocolVersion: 1 },
      'session/new': { sessionId: 'session-A' },
    });
    await createSession(session);
    const configuring = session.configure(() => gate.promise);
    const closing = session.close();
    if (failure) gate.reject(failure); else gate.resolve();
    if (failure) await assert.rejects(configuring, (error) => error === failure);
    else await configuring;
    await closing;
    await assert.rejects(session.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('closed'));
  }
});

test('late operations after close produce no wire effects', async () => {
  const { session, connection } = sessionWith({ initialize: { protocolVersion: 1 } });
  await session.close();
  const count = connection.requests.length;
  await assert.rejects(session.initialize(INITIALIZE_REQUEST), hasSessionCode('closed'));
  await assert.rejects(session.create({ cwd: '/repo', mcpServers: [] }), hasSessionCode('closed'));
  await assert.rejects(session.configure(async () => {}), hasSessionCode('closed'));
  await assert.rejects(session.setConfigOption({ sessionId: 'session-A', configId: 'x', value: 'y' }), hasSessionCode('closed'));
  await assert.rejects(session.prompt({ sessionId: 'session-A', prompt: [{ type: 'text', text: 'x' }] }), hasSessionCode('closed'));
  await assert.rejects(session.receiveUpdate({ sessionId: 'session-A', update: { kind: 'agent-text', text: 'x' } }), hasSessionCode('closed'));
  assert.throws(() => session.assertPermissionRequest(PERMISSION_REQUEST), hasSessionCode('closed'));
  assert.equal(connection.requests.length, count);
});
