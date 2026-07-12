import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonRpcConnection } from '../connection.js';
import { JsonRpcProtocolError } from '../errors.js';
import type { JsonRpcMessage } from '../types.js';

const decoder = new TextDecoder();

function decodeWrite(chunk: Uint8Array): JsonRpcMessage {
  return JSON.parse(decoder.decode(chunk).trim()) as JsonRpcMessage;
}

function unsafeToJsonObject(): Record<string, unknown> {
  const value = { accepted: true };
  Object.defineProperty(value, 'toJSON', {
    value: () => 1n,
  });
  return value;
}

function substitutingJsonProxy(): Record<string, unknown> {
  const target = { accepted: true };
  return new Proxy(target, {
    get(current, key, receiver) {
      if (key === 'toJSON') return () => ({ substituted: true });
      return Reflect.get(current, key, receiver);
    },
    getOwnPropertyDescriptor: (current, key) => Reflect.getOwnPropertyDescriptor(current, key),
    getPrototypeOf: (current) => Reflect.getPrototypeOf(current),
    ownKeys: (current) => Reflect.ownKeys(current),
  });
}

async function assertFailure(code: JsonRpcProtocolError['code'], run: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof JsonRpcProtocolError);
  assert.equal(caught.code, code);
}

test('connection assigns monotonic ids and resolves out-of-order responses', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  const first = connection.request('first', { value: 1 });
  const second = connection.request('second');
  await Promise.resolve();

  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', method: 'first', params: { value: 1 }, id: 1 },
    { jsonrpc: '2.0', method: 'second', id: 2 },
  ]);

  await connection.receive({ jsonrpc: '2.0', id: 2, result: 'two' });
  await connection.receive({ jsonrpc: '2.0', id: 1, result: 'one' });
  assert.equal(await first, 'one');
  assert.equal(await second, 'two');
});

test('connection resolves a response before its transport write settles', async () => {
  let releaseWrite!: () => void;
  const writePending = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const connection = createJsonRpcConnection({
    write: async () => writePending,
  });

  const request = connection.request('buffered');
  let observed: unknown;
  void request.then((value) => {
    observed = value;
  });

  try {
    await connection.receive({ jsonrpc: '2.0', id: 1, result: 'early' });
    await Promise.resolve();
    assert.equal(observed, 'early');
  } finally {
    releaseWrite();
  }
  assert.equal(await request, 'early');
});

test('invalid outbound request does not allocate pending state or consume an id', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  await assertFailure('invalid_message', () => connection.request('  '));
  const valid = connection.request('valid');
  await Promise.resolve();
  assert.deepEqual(writes.map(decodeWrite), [{ jsonrpc: '2.0', method: 'valid', id: 1 }]);
  await connection.receive({ jsonrpc: '2.0', id: 1, result: 'accepted' });
  assert.equal(await valid, 'accepted');
});

test('unsafe outbound params fail before pending allocation, id consumption, or write', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  await assertFailure('invalid_message', () => connection.request('unsafe', unsafeToJsonObject() as never));
  const valid = connection.request('valid');
  await Promise.resolve();
  assert.deepEqual(writes.map(decodeWrite), [{ jsonrpc: '2.0', method: 'valid', id: 1 }]);
  await connection.receive({ jsonrpc: '2.0', id: 1, result: true });
  assert.equal(await valid, true);
});

test('outbound request serializes canonical params instead of proxy substitution', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  const pending = connection.request('proxy', substitutingJsonProxy() as never);
  await Promise.resolve();
  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', method: 'proxy', params: { accepted: true }, id: 1 },
  ]);
  await connection.receive({ jsonrpc: '2.0', id: 1, result: true });
  assert.equal(await pending, true);
});

test('connection distinguishes unknown, duplicate, and null response ids', async () => {
  const connection = createJsonRpcConnection({ async write() {} });
  const pending = connection.request('known');
  await Promise.resolve();
  await connection.receive({ jsonrpc: '2.0', id: 1, result: true });
  assert.equal(await pending, true);

  await assertFailure('duplicate_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: 1, result: true }),
  );
  await assertFailure('unknown_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: 99, result: true }),
  );
  const numeric = connection.request('numeric');
  await assertFailure('unknown_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: '2', result: true }),
  );
  await connection.receive({ jsonrpc: '2.0', id: 2, result: 'numeric' });
  assert.equal(await numeric, 'numeric');
  await assertFailure('uncorrelated_null_response', () =>
    connection.receive({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
  );
});

test('send failure rejects only its request and leaves other pending calls correlatable', async () => {
  let writeNo = 0;
  const connection = createJsonRpcConnection({
    async write() {
      writeNo += 1;
      if (writeNo === 2) throw new Error('broken pipe');
    },
  });

  const first = connection.request('first');
  const second = connection.request('second');
  await assertFailure('send_failed', () => second);
  await connection.receive({ jsonrpc: '2.0', id: 1, result: 'survived' });
  assert.equal(await first, 'survived');
  await assertFailure('unknown_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: 2, result: 'late' }),
  );
  await connection.notify('still-writable');
  assert.equal(writeNo, 3);
});

test('write queue advances queued work after an already-queued write fails', async () => {
  const started: string[] = [];
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const connection = createJsonRpcConnection({
    async write(chunk) {
      const message = decodeWrite(chunk);
      assert.ok('method' in message);
      started.push(message.method);
      if (message.method === 'first') await firstBlocked;
      if (message.method === 'second') throw new Error('broken pipe');
    },
  });

  const first = connection.notify('first');
  const secondFailure = assertFailure('send_failed', () => connection.notify('second'));
  const third = connection.notify('third');
  const thirdOutcome = third.then(
    () => 'resolved' as const,
    (error: unknown) => error,
  );
  assert.deepEqual(started, ['first']);

  try {
    releaseFirst();
    await first;
    await secondFailure;
    await Promise.resolve();
    assert.deepEqual(started, ['first', 'second', 'third']);
    assert.equal(await thirdOutcome, 'resolved');
  } finally {
    connection.close();
    await thirdOutcome;
  }
});

test('connection serializes notification, request, and server-response writes', async () => {
  const started: JsonRpcMessage[] = [];
  const releases: Array<() => void> = [];
  const connection = createJsonRpcConnection({
    async write(chunk) {
      started.push(decodeWrite(chunk));
      await new Promise<void>((resolve) => releases.push(resolve));
    },
    async onRequest() { return { kind: 'result', value: true }; },
  });

  const notification = connection.notify('first');
  const request = connection.request('second');
  const serverResponse = connection.receive({ jsonrpc: '2.0', method: 'third', id: 'server' });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(started, [{ jsonrpc: '2.0', method: 'first' }]);

  releases.shift()!();
  await notification;
  await Promise.resolve();
  assert.deepEqual(started, [
    { jsonrpc: '2.0', method: 'first' },
    { jsonrpc: '2.0', method: 'second', id: 1 },
  ]);

  releases.shift()!();
  await connection.receive({ jsonrpc: '2.0', id: 1, result: 'done' });
  assert.equal(await request, 'done');
  await Promise.resolve();
  assert.deepEqual(started, [
    { jsonrpc: '2.0', method: 'first' },
    { jsonrpc: '2.0', method: 'second', id: 1 },
    { jsonrpc: '2.0', id: 'server', result: true },
  ]);
  releases.shift()!();
  await serverResponse;
});

test('close prevents queued and post-handler writes from starting', async () => {
  const writes: JsonRpcMessage[] = [];
  let releaseWrite!: () => void;
  let releaseHandler!: () => void;
  const handlerPending = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  const connection = createJsonRpcConnection({
    async write(chunk) {
      writes.push(decodeWrite(chunk));
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    },
    async onRequest() {
      await handlerPending;
      return { kind: 'result', value: true };
    },
  });

  const inFlight = connection.notify('started');
  const queued = connection.notify('queued');
  const inbound = connection.receive({ jsonrpc: '2.0', method: 'server', id: 9 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(writes, [{ jsonrpc: '2.0', method: 'started' }]);

  connection.close();
  releaseWrite();
  releaseHandler();
  await inFlight;
  await assertFailure('closed', () => queued);
  await assertFailure('closed', () => inbound);
  assert.deepEqual(writes, [{ jsonrpc: '2.0', method: 'started' }]);
});

test('remote error rejects its pending request with the original error details', async () => {
  const connection = createJsonRpcConnection({ async write() {} });
  const pending = connection.request('fail');
  const observed = pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  await Promise.resolve();

  const remote = { code: -32001, message: 'Provider failed', data: { retryable: false } };
  await connection.receive({ jsonrpc: '2.0', id: 1, error: remote });
  const error = await observed;

  assert.ok(error instanceof JsonRpcProtocolError);
  assert.equal(error.code, 'remote_error');
  assert.deepEqual(error.details, remote);
});

test('notify writes no id and close idempotently rejects every pending request', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  await connection.notify('changed', [1, 2]);
  assert.deepEqual(decodeWrite(writes[0]!), { jsonrpc: '2.0', method: 'changed', params: [1, 2] });

  const first = connection.request('first');
  const second = connection.request('second');
  const firstClosed = assertFailure('closed', () => first);
  const secondClosed = assertFailure('closed', () => second);
  connection.close();
  connection.close();
  await Promise.all([firstClosed, secondClosed]);
  await assertFailure('closed', () => connection.request('after-close'));
});

test('connection delegates server requests and serializes success or declared error responses', async () => {
  const writes: Uint8Array[] = [];
  const methods: string[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onRequest(request) {
      methods.push(request.method);
      if (request.method === 'allowed') return { kind: 'result', value: { accepted: true } };
      return { kind: 'error', error: { code: -32601, message: 'Method not found' } };
    },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'allowed', id: 'server-1' });
  await connection.receive({ jsonrpc: '2.0', method: 'missing', id: 'server-2' });

  assert.deepEqual(methods, ['allowed', 'missing']);
  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', id: 'server-1', result: { accepted: true } },
    { jsonrpc: '2.0', id: 'server-2', error: { code: -32601, message: 'Method not found' } },
  ]);
});

test('connection converts thrown server handler failures to internal errors', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onRequest() { throw new Error('secret provider failure'); },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'explode', id: 8 });

  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', id: 8, error: { code: -32603, message: 'Internal error' } },
  ]);
});

test('connection converts invalid server handler outcomes to internal errors', async () => {
  const invalidOutcomes: unknown[] = [
    { kind: 'result', value: Number.NaN },
    { kind: 'error', error: { code: 1.5, message: 'Bad' } },
    { kind: 'error', error: { code: -32603, message: ' ' } },
  ];

  for (const [index, invalidOutcome] of invalidOutcomes.entries()) {
    const writes: Uint8Array[] = [];
    const connection = createJsonRpcConnection({
      async write(chunk) { writes.push(chunk); },
      async onRequest() {
        return invalidOutcome as never;
      },
    });

    await connection.receive({ jsonrpc: '2.0', method: 'invalid', id: index + 1 });
    assert.deepEqual(writes.map(decodeWrite), [
      { jsonrpc: '2.0', id: index + 1, error: { code: -32603, message: 'Internal error' } },
    ]);
  }
});

test('connection converts a serialization-hostile server result to an internal error', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onRequest() {
      return { kind: 'result', value: unsafeToJsonObject() } as never;
    },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'unsafe', id: 7 });
  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Internal error' } },
  ]);
});

test('connection serializes a canonical handler result instead of proxy substitution', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onRequest() {
      return { kind: 'result', value: substitutingJsonProxy() } as never;
    },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'proxy', id: 8 });
  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', id: 8, result: { accepted: true } },
  ]);
});

test('connection does not hide transport failure while sending an internal error', async () => {
  const connection = createJsonRpcConnection({
    async write() { throw new Error('broken pipe'); },
    async onRequest() { return { kind: 'result', value: Number.NaN } as never; },
  });

  await assertFailure('send_failed', () =>
    connection.receive({ jsonrpc: '2.0', method: 'invalid', id: 1 }),
  );
});

test('connection bounds recent response history while retaining recent duplicates', async () => {
  const connection = createJsonRpcConnection({ async write() {} });
  for (let id = 1; id <= 1_025; id += 1) {
    const pending = connection.request('settle');
    await connection.receive({ jsonrpc: '2.0', id, result: id });
    assert.equal(await pending, id);
  }

  await assertFailure('unknown_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: 1, result: true }),
  );
  await assertFailure('duplicate_response_id', () =>
    connection.receive({ jsonrpc: '2.0', id: 2, result: true }),
  );
});

test('connection delegates notifications without writing a response', async () => {
  const writes: Uint8Array[] = [];
  const notifications: Array<{ method: string; params?: unknown }> = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onNotification(notification) { notifications.push(notification); },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'progress', params: { done: 2 } });

  assert.deepEqual(notifications, [{ method: 'progress', params: { done: 2 } }]);
  assert.deepEqual(writes, []);
});

test('connection reports a notification handler failure without sending a response', async () => {
  const writes: Uint8Array[] = [];
  let called = false;
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
    async onNotification() {
      called = true;
      throw new Error('notification failed');
    },
  });

  await assertFailure('handler_failed', () =>
    connection.receive({ jsonrpc: '2.0', method: 'progress' }),
  );
  assert.equal(called, true);
  assert.deepEqual(writes, []);
});

test('connection applies absent request and notification handler defaults', async () => {
  const writes: Uint8Array[] = [];
  const connection = createJsonRpcConnection({
    async write(chunk) { writes.push(chunk); },
  });

  await connection.receive({ jsonrpc: '2.0', method: 'missing', id: 'server-default' });
  await connection.receive({ jsonrpc: '2.0', method: 'progress' });

  assert.deepEqual(writes.map(decodeWrite), [
    { jsonrpc: '2.0', id: 'server-default', error: { code: -32601, message: 'Method not found' } },
  ]);
});
