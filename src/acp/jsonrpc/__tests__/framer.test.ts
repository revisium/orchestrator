import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProtocolError, parseJsonRpcMessage } from '../types.js';

function assertFailure(code: JsonRpcProtocolError['code'], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof JsonRpcProtocolError && error.code === code);
}

test('parseJsonRpcMessage accepts the Slice 1 JSON-RPC 2.0 message subset', () => {
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'subtract', params: [42, 23], id: 1 }),
    { jsonrpc: '2.0', method: 'subtract', params: [42, 23], id: 1 },
  );
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'update', params: { value: true } }),
    { jsonrpc: '2.0', method: 'update', params: { value: true } },
  );
  assert.deepEqual(parseJsonRpcMessage({ jsonrpc: '2.0', result: 19, id: 'request-1' }), {
    jsonrpc: '2.0',
    result: 19,
    id: 'request-1',
  });
  assert.deepEqual(
    parseJsonRpcMessage({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    }),
    { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
  );
});

test('parseJsonRpcMessage rejects batch and invalid request shapes', () => {
  assertFailure('invalid_message', () => parseJsonRpcMessage([]));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '1.0', method: 'run', id: 1 }));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', method: ' ', id: 1 }));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', id: 1.5 }));
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: 'not-structured', id: 1 }),
  );
});

test('parseJsonRpcMessage rejects non-plain object params', () => {
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: new Date(), id: 1 }),
  );
});

test('parseJsonRpcMessage rejects sparse array params', () => {
  const sparseParams: unknown[] = [];
  sparseParams.length = 1;

  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: sparseParams, id: 1 }),
  );
});

test('parseJsonRpcMessage requires exactly one response branch and validates null ids', () => {
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', id: 1 }));
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', result: true, error: { code: -32603, message: 'Internal' }, id: 1 }),
  );
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', error: { code: 1.5, message: 'Bad' }, id: 1 }),
  );
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', error: { code: -32603, message: ' ' }, id: 1 }),
  );
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal' }, id: null }),
  );
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', result: null, id: null }));
});
