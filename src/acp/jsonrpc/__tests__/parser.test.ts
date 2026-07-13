import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProtocolError } from '../errors.js';
import { parseJsonRpcMessage } from '../parser.js';

function assertFailure(code: JsonRpcProtocolError['code'], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof JsonRpcProtocolError && error.code === code);
}

function restoreOwnProperty(value: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(value, key, descriptor);
    return;
  }
  Reflect.deleteProperty(value, key);
}

function nestedArray(depth: number): unknown {
  let value: unknown = null;
  for (let currentDepth = 1; currentDepth < depth; currentDepth += 1) value = [value];
  return value;
}

test('parseJsonRpcMessage accepts the Slice 1 JSON-RPC 2.0 message subset', () => {
  assert.deepEqual(parseJsonRpcMessage({ jsonrpc: '2.0', method: 'subtract', params: [42, 23], id: 1 }), {
    jsonrpc: '2.0', method: 'subtract', params: [42, 23], id: 1,
  });
  assert.deepEqual(parseJsonRpcMessage({ jsonrpc: '2.0', method: 'update', params: { value: true } }), {
    jsonrpc: '2.0', method: 'update', params: { value: true },
  });
  assert.deepEqual(parseJsonRpcMessage({ jsonrpc: '2.0', result: 19, id: 'request-1' }), {
    jsonrpc: '2.0', result: 19, id: 'request-1',
  });
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }),
    { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
  );
});

test('parseJsonRpcMessage rejects batch, invalid request, and invalid response shapes', () => {
  assertFailure('invalid_message', () => parseJsonRpcMessage([]));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '1.0', method: 'run', id: 1 }));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', method: ' ', id: 1 }));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', id: 1.5 }));
  assertFailure('invalid_message', () => parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', id: null }));
  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: 'not-structured', id: 1 }),
  );
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

test('parseJsonRpcMessage accepts JSON values through depth 256 and rejects depth 257', () => {
  const accepted = nestedArray(256);
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: accepted, id: 1 }),
    { jsonrpc: '2.0', method: 'run', params: accepted, id: 1 },
  );

  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: nestedArray(257), id: 1 }),
  );
});

test('parseJsonRpcMessage rejects cyclic JSON values with a typed failure', () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: cyclic, id: 1 }),
  );
});

test('parseJsonRpcMessage accepts only stable JSON container properties', () => {
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => true,
  });
  const nonEnumerable = Object.defineProperty({}, 'value', { value: true });
  const symbolKey = { value: true };
  Object.defineProperty(symbolKey, Symbol('hidden'), { value: true, enumerable: true });
  const arrayAccessor = [true];
  Object.defineProperty(arrayAccessor, '0', { enumerable: true, get: () => true });
  const arrayExtra = [true];
  Object.defineProperty(arrayExtra, 'extra', { value: true, enumerable: true });
  const arraySubclass = new (class extends Array<unknown> {})(true);

  for (const params of [accessor, nonEnumerable, symbolKey, arrayAccessor, arrayExtra, arraySubclass]) {
    assertFailure('invalid_message', () =>
      parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params, id: 1 }),
    );
  }

  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params: { toJSON: 'ordinary' }, id: 1 }),
    { jsonrpc: '2.0', method: 'run', params: { toJSON: 'ordinary' }, id: 1 },
  );
});

test('parseJsonRpcMessage snapshots top-level and error records before reading fields', () => {
  const requestTarget = { jsonrpc: '2.0', method: 'stable', params: { accepted: true }, id: 1 };
  const request = new Proxy(requestTarget, {
    get(current, key, receiver) {
      if (key === 'method') return 'substituted';
      return Reflect.get(current, key, receiver);
    },
  });
  const errorTarget = { code: -32000, message: 'Stable', data: { accepted: true } };
  const error = new Proxy(errorTarget, {
    get(current, key, receiver) {
      if (key === 'message') return 'Substituted';
      return Reflect.get(current, key, receiver);
    },
  });

  assert.deepEqual(parseJsonRpcMessage(request), requestTarget);
  assert.deepEqual(
    parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, error }),
    { jsonrpc: '2.0', id: 1, error: errorTarget },
  );
});

test('parseJsonRpcMessage requires own protocol and error fields despite prototype pollution', () => {
  const jsonrpc = Object.getOwnPropertyDescriptor(Object.prototype, 'jsonrpc');
  const code = Object.getOwnPropertyDescriptor(Object.prototype, 'code');
  const message = Object.getOwnPropertyDescriptor(Object.prototype, 'message');

  try {
    Object.defineProperties(Object.prototype, {
      jsonrpc: { configurable: true, value: '2.0', writable: true },
      code: { configurable: true, value: -32001, writable: true },
      message: { configurable: true, value: 'Polluted', writable: true },
    });

    assertFailure('invalid_message', () => parseJsonRpcMessage({ method: 'missing-version' }));
    assertFailure('invalid_message', () =>
      parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, error: { message: 'Own message' } }),
    );
    assertFailure('invalid_message', () =>
      parseJsonRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -32001 } }),
    );
  } finally {
    restoreOwnProperty(Object.prototype, 'jsonrpc', jsonrpc);
    restoreOwnProperty(Object.prototype, 'code', code);
    restoreOwnProperty(Object.prototype, 'message', message);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'jsonrpc'), jsonrpc);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'code'), code);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, 'message'), message);
  }
});

test('canonicalizer rejects inflated Proxy array length before numeric descriptor reads', () => {
  let numericDescriptorReads = 0;
  const target = [true];
  const params = new Proxy(target, {
    getOwnPropertyDescriptor(current, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      if (key === 'length') return { ...descriptor!, value: 1_024 };
      if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) numericDescriptorReads += 1;
      return descriptor;
    },
    getPrototypeOf: (current) => Reflect.getPrototypeOf(current),
    ownKeys: (current) => Reflect.ownKeys(current),
  });

  assertFailure('invalid_message', () =>
    parseJsonRpcMessage({ jsonrpc: '2.0', method: 'run', params, id: 1 }),
  );
  assert.equal(numericDescriptorReads, 0);
});
