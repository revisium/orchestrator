import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpSession, createAcpSession } from '../session.js';
import { AcpSessionError } from '../session.errors.js';
import type { JsonRpcConnection } from '../jsonrpc/connection.types.js';
import type { JsonRpcParams, JsonRpcValue } from '../jsonrpc/types.js';

type Request = { method: string; params: JsonRpcParams | undefined };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
type FakeConnection = JsonRpcConnection & { readonly requests: Request[] };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function rejected(error: unknown): Promise<JsonRpcValue> {
  const result = Promise.reject<JsonRpcValue>(error);
  void result.catch(() => {});
  return result;
}

function createFakeConnection(
  responses: Record<string, JsonRpcValue | Promise<JsonRpcValue>>,
  trace?: string[],
): FakeConnection {
  const requests: Request[] = [];
  return {
    requests,
    request(method, params) {
      requests.push({ method, params });
      trace?.push(method);
      if (!Object.hasOwn(responses, method)) {
        return Promise.reject(new Error(`missing fake response for ${method}`));
      }
      return Promise.resolve(responses[method]);
    },
    async notify() {},
    async receive() {},
    close() {},
  };
}

function createSession(
  connection: JsonRpcConnection,
  options: Partial<Pick<Parameters<typeof createAcpSession>[0], 'configure' | 'onUpdate' | 'onDiagnostic'>> = {},
) {
  return createAcpSession({
    connection,
    configure: async () => {},
    onUpdate: async () => {},
    onDiagnostic: () => {},
    ...options,
  });
}

test('transient session accepts exactly one invocation binding', () => {
  const session = new AcpSession();
  const deps = {
    connection: createFakeConnection({}),
    configure: async () => {},
    onUpdate: async () => {},
    onDiagnostic: () => {},
  };
  session.bindDependencies(deps);

  assert.throws(() => session.bindDependencies(deps));
  assert.equal(session.getSessionId(), null);
});
async function assertSessionFailure(
  code: AcpSessionError['code'],
  run: () => Promise<unknown>,
): Promise<AcpSessionError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AcpSessionError);
  assert.equal(caught.code, code);
  return caught;
}

async function assertRawFailure(expected: unknown, run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.strictEqual(caught, expected);
}

async function establish(session: ReturnType<typeof createAcpSession>): Promise<void> {
  await session.initialize();
  await session.create();
}

test('creates exactly one session after protocol v1 initialize', async () => {
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'session-A' },
  });
  const session = createSession(connection);

  assert.equal(session.getSessionId(), null);
  await session.initialize();
  assert.equal(await session.create(), 'session-A');
  assert.equal(session.getSessionId(), 'session-A');
  assert.deepEqual(connection.requests, [
    { method: 'initialize', params: { protocolVersion: 1 } },
    { method: 'session/new', params: undefined },
  ]);
});

test('rejects an incompatible initialize response before session/new', async () => {
  const connection = createFakeConnection({ initialize: { protocolVersion: 2 } });
  const session = createSession(connection);

  await assertSessionFailure('invalid_protocol_version', () => session.initialize());
  assert.equal(session.getSessionId(), null);
  assert.deepEqual(connection.requests, [{ method: 'initialize', params: { protocolVersion: 1 } }]);
  await assertSessionFailure('failed', () => session.create());
});

test('requires an own nonempty string session id and preserves null provenance on failure', async () => {
  const inherited = Object.create({ sessionId: 'inherited' }) as JsonRpcValue;
  for (const response of [
    {},
    { sessionId: '' },
    { sessionId: 1 },
    inherited,
  ] as JsonRpcValue[]) {
    const connection = createFakeConnection({ initialize: { protocolVersion: 1 }, 'session/new': response });
    const session = createSession(connection);
    await session.initialize();

    await assertSessionFailure('invalid_session_id', () => session.create());
    assert.equal(session.getSessionId(), null);
    await assertSessionFailure('failed', () => session.configure());
    await assertSessionFailure('failed', () => session.prompt('never'));
  }
});

test('reserves initialize before its first await', async () => {
  const gate = deferred<JsonRpcValue>();
  const connection = createFakeConnection({ initialize: gate.promise });
  const session = createSession(connection);

  const first = session.initialize();
  await assertSessionFailure('initialize_already_started', () => session.initialize());
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize']);
  gate.resolve({ protocolVersion: 1 });
  await first;
});

test('runs the full lifecycle once in protocol order without extra configuration or transport calls', async () => {
  const trace: string[] = [];
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
    'session/prompt': { accepted: true },
    'session/close': null,
  }, trace);
  const session = createSession(connection, {
    configure: async (sessionId) => { trace.push(`configure:${sessionId}`); },
  });

  await establish(session);
  await session.configure();
  assert.deepEqual(await session.prompt({ text: 'work' }), { accepted: true });
  await session.close();
  assert.deepEqual(trace, ['initialize', 'session/new', 'configure:s', 'session/prompt', 'session/close']);
  assert.deepEqual(connection.requests[2], {
    method: 'session/prompt',
    params: { sessionId: 's', prompt: { text: 'work' } },
  });
  assert.deepEqual(connection.requests.at(-1), {
    method: 'session/close',
    params: { sessionId: 's' },
  });
});

test('rejects out-of-order and sequentially repeated actions without duplicate requests', async () => {
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
    'session/prompt': true,
  });
  const session = createSession(connection);

  await assertSessionFailure('session_new_already_started', () => session.create());
  await assertSessionFailure('configuration_before_session', () => session.configure());
  await assertSessionFailure('prompt_before_session', () => session.prompt('x'));
  await establish(session);
  await session.configure();
  await session.prompt('x');
  await assertSessionFailure('initialize_already_started', () => session.initialize());
  await assertSessionFailure('session_new_already_started', () => session.create());
  await assertSessionFailure('configuration_already_started', () => session.configure());
  await assertSessionFailure('prompt_already_started', () => session.prompt('y'));
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/prompt']);
});

test('reserves initialize, create, and prompt before their first await', async () => {
  const initializeGate = deferred<JsonRpcValue>();
  const createGate = deferred<JsonRpcValue>();
  const promptGate = deferred<JsonRpcValue>();
  const connection = createFakeConnection({
    initialize: initializeGate.promise,
    'session/new': createGate.promise,
    'session/prompt': promptGate.promise,
  });
  const session = createSession(connection);

  const firstInitialize = session.initialize();
  await assertSessionFailure('initialize_already_started', () => session.initialize());
  initializeGate.resolve({ protocolVersion: 1 });
  await firstInitialize;

  const firstCreate = session.create();
  await assertSessionFailure('session_new_already_started', () => session.create());
  createGate.resolve({ sessionId: 's' });
  await firstCreate;
  await session.configure();

  const firstPrompt = session.prompt('x');
  await assertSessionFailure('prompt_already_started', () => session.prompt('y'));
  promptGate.resolve({ done: true });
  await firstPrompt;
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/prompt']);
});

test('reserves configuration before its hook settles and does not invoke a second hook', async () => {
  const configurationGate = deferred<void>();
  let configurations = 0;
  const session = createSession(createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
  }), {
    configure: async () => {
      configurations += 1;
      await configurationGate.promise;
    },
  });
  await establish(session);

  const first = session.configure();
  await assertSessionFailure('configuration_already_started', () => session.configure());
  assert.equal(configurations, 1);
  configurationGate.resolve();
  await first;
  assert.equal(configurations, 1);
});

test('forwards an exact-session update unchanged', async () => {
  const received: JsonRpcValue[] = [];
  const session = createSession(createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'A' },
  }), {
    onUpdate: async ({ sessionId, update }) => {
      assert.equal(sessionId, 'A');
      received.push(update);
    },
  });
  await establish(session);

  const update: JsonRpcValue = { kind: 'message', content: ['exact'] };
  await session.receiveUpdate({ sessionId: 'A', update });
  assert.deepEqual(received, [update]);
});

test('diagnoses foreign and malformed updates then preserves the original typed failure', async () => {
  const inherited = Object.create({ sessionId: 'owned' }) as { update: JsonRpcValue };
  inherited.update = true;
  for (const subject of [
    { params: { sessionId: 'foreign', update: true }, code: 'foreign_session_update' as const },
    { params: { sessionId: '', update: true }, code: 'malformed_session_update' as const },
    { params: null, code: 'malformed_session_update' as const },
    { params: [], code: 'malformed_session_update' as const },
    { params: { sessionId: 'owned' }, code: 'malformed_session_update' as const },
    { params: { sessionId: 1, update: true }, code: 'malformed_session_update' as const },
    { params: inherited, code: 'malformed_session_update' as const },
  ]) {
    const diagnostics: string[] = [];
    const session = createSession(createFakeConnection({
      initialize: { protocolVersion: 1 },
      'session/new': { sessionId: 'owned' },
    }), {
      onUpdate: async () => assert.fail('invalid update must not route'),
      onDiagnostic: ({ code }) => diagnostics.push(code),
    });
    await establish(session);

    const first = await assertSessionFailure(subject.code, () => session.receiveUpdate(subject.params));
    assert.deepEqual(diagnostics, [subject.code]);
    const second = await assertSessionFailure(subject.code, () => session.prompt('never'));
    assert.strictEqual(second, first);
  }
});

test('diagnoses an out-of-order update without touching the transport', async () => {
  const diagnostics: string[] = [];
  const connection = createFakeConnection({});
  const session = createSession(connection, {
    onUpdate: async () => assert.fail('out-of-order update must not route'),
    onDiagnostic: ({ code }) => diagnostics.push(code),
  });

  const failure = await assertSessionFailure('unexpected_update', () =>
    session.receiveUpdate({ sessionId: 'owned', update: true }),
  );
  assert.deepEqual(diagnostics, ['unexpected_update']);
  assert.deepEqual(connection.requests, []);
  assert.strictEqual(await assertSessionFailure('unexpected_update', () => session.initialize()), failure);
});

test('fails closed after raw initialize, configure, and prompt errors', async () => {
  const initializeError = new Error('initialize transport failed');
  const initialize = createSession(createFakeConnection({ initialize: rejected(initializeError) }));
  await assertRawFailure(initializeError, () => initialize.initialize());
  await assertSessionFailure('failed', () => initialize.create());

  const createError = new Error('session/new transport failed');
  const creatingConnection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': rejected(createError),
  });
  const creating = createSession(creatingConnection);
  await creating.initialize();
  await assertRawFailure(createError, () => creating.create());
  assert.equal(creating.getSessionId(), null);
  await assertSessionFailure('failed', () => creating.create());
  await assertSessionFailure('failed', () => creating.configure());
  await assertSessionFailure('failed', () => creating.prompt('never'));
  assert.deepEqual(creatingConnection.requests.map(({ method }) => method), ['initialize', 'session/new']);

  const configureError = new Error('configure failed');
  const configured = createSession(createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'configured' },
  }), { configure: async () => { throw configureError; } });
  await establish(configured);
  await assertRawFailure(configureError, () => configured.configure());
  assert.equal(configured.getSessionId(), 'configured');
  await assertSessionFailure('failed', () => configured.prompt('never'));

  const promptError = new Error('prompt transport failed');
  const prompted = createSession(createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'prompted' },
    'session/prompt': rejected(promptError),
  }));
  await establish(prompted);
  await prompted.configure();
  await assertRawFailure(promptError, () => prompted.prompt('run'));
  assert.equal(prompted.getSessionId(), 'prompted');
  await assertSessionFailure('failed', () => prompted.receiveUpdate({ sessionId: 'prompted', update: true }));
});

test('shares one best-effort close operation and permanently fences work', async () => {
  const closeGate = deferred<JsonRpcValue>();
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
    'session/close': closeGate.promise,
  });
  const session = createSession(connection);
  await establish(session);

  const [first, second] = [session.close(), session.close()];
  assert.deepEqual(connection.requests.at(-1), { method: 'session/close', params: { sessionId: 's' } });
  await assertSessionFailure('closed', () => session.configure());
  closeGate.resolve(null);
  await Promise.all([first, second]);
  assert.equal(connection.requests.filter(({ method }) => method === 'session/close').length, 1);
  await assertSessionFailure('closed', () => session.prompt('never'));
});

test('suppresses close transport failure after one diagnostic', async () => {
  const diagnostics: string[] = [];
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
    'session/close': rejected(new Error('close transport failed')),
  });
  const session = createSession(connection, { onDiagnostic: ({ code }) => diagnostics.push(code) });
  await establish(session);

  await session.close();
  assert.deepEqual(diagnostics, ['close_failed']);
  await assertSessionFailure('closed', () => session.create());
});

test('fences close before a session exists and cleans up a session acquired during a close race', async () => {
  const before = createSession(createFakeConnection({}));
  await before.close();
  await assertSessionFailure('closed', () => before.initialize());
  await assertSessionFailure('closed', () => before.create());
  await assertSessionFailure('closed', () => before.configure());
  await assertSessionFailure('closed', () => before.prompt('never'));

  const createGate = deferred<JsonRpcValue>();
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': createGate.promise,
    'session/close': null,
  });
  const duringCreate = createSession(connection);
  await duringCreate.initialize();
  const creating = duringCreate.create();
  const closing = duringCreate.close();
  createGate.resolve({ sessionId: 'late' });
  await creating;
  await closing;
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/close']);
  assert.deepEqual(connection.requests.at(-1), { method: 'session/close', params: { sessionId: 'late' } });
  await assertSessionFailure('closed', () => duringCreate.configure());
});

test('does not create or close a session when close races a held initialize', async () => {
  const initializeGate = deferred<JsonRpcValue>();
  const connection = createFakeConnection({ initialize: initializeGate.promise });
  const session = createSession(connection);

  const initializing = session.initialize();
  const closing = session.close();
  initializeGate.resolve({ protocolVersion: 1 });
  await initializing;
  await closing;
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize']);
  await assertSessionFailure('closed', () => session.create());
  await assertSessionFailure('closed', () => session.configure());
  await assertSessionFailure('closed', () => session.prompt('never'));
});

test('does not let a held configuration reopen work after close begins', async () => {
  const configurationGate = deferred<void>();
  const connection = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 's' },
    'session/close': null,
  });
  const session = createSession(connection, { configure: async () => configurationGate.promise });
  await establish(session);

  const configuring = session.configure();
  const closing = session.close();
  await assertSessionFailure('closed', () => session.prompt('never'));
  configurationGate.resolve();
  await configuring;
  await closing;
  await assertSessionFailure('closed', () => session.prompt('never'));
  assert.deepEqual(connection.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/close']);
});

test('keeps two connection/controller lifecycles isolated', async () => {
  const first = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'first' },
    'session/prompt': 'first-result',
    'session/close': null,
  });
  const second = createFakeConnection({
    initialize: { protocolVersion: 1 },
    'session/new': { sessionId: 'second' },
    'session/prompt': 'second-result',
    'session/close': null,
  });
  const firstUpdates: JsonRpcValue[] = [];
  const secondUpdates: JsonRpcValue[] = [];
  const one = createSession(first, { onUpdate: async ({ update }) => { firstUpdates.push(update); } });
  const two = createSession(second, { onUpdate: async ({ update }) => { secondUpdates.push(update); } });

  await Promise.all([one.initialize(), two.initialize()]);
  await Promise.all([one.create(), two.create()]);
  await Promise.all([one.configure(), two.configure()]);
  await Promise.all([
    one.receiveUpdate({ sessionId: 'first', update: 1 }),
    two.receiveUpdate({ sessionId: 'second', update: 2 }),
  ]);
  assert.equal(await one.prompt('one'), 'first-result');
  assert.equal(await two.prompt('two'), 'second-result');
  await Promise.all([one.close(), two.close()]);
  assert.deepEqual(firstUpdates, [1]);
  assert.deepEqual(secondUpdates, [2]);
  assert.deepEqual(first.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/prompt', 'session/close']);
  assert.deepEqual(second.requests.map(({ method }) => method), ['initialize', 'session/new', 'session/prompt', 'session/close']);
});
