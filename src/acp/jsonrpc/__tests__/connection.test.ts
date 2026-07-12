import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonRpcConnection } from '../connection.js';
import { JsonRpcProtocolError, type JsonRpcMessage } from '../types.js';

const decoder = new TextDecoder();

function decodeWrite(chunk: Uint8Array): JsonRpcMessage {
  return JSON.parse(decoder.decode(chunk).trim()) as JsonRpcMessage;
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
