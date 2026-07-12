import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcProtocolError } from '../errors.js';
import { createJsonRpcFramer } from '../framer.js';
import { parseJsonRpcMessage } from '../parser.js';

const encoder = new TextEncoder();

function assertFailure(code: JsonRpcProtocolError['code'], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof JsonRpcProtocolError && error.code === code);
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

test('framer accepts fragmented multibyte UTF-8 and multiple LF or CRLF frames', () => {
  const framer = createJsonRpcFramer();
  const bytes = encoder.encode(
    '{"jsonrpc":"2.0","method":"echo","params":{"text":"🙂"},"id":1}\r\n' +
    '\n{"jsonrpc":"2.0","method":"notify"}\n',
  );
  const emojiStart = bytes.findIndex((value) => value === 0xf0);

  assert.deepEqual(framer.push(bytes.slice(0, emojiStart + 2)), []);
  assert.deepEqual(framer.push(bytes.slice(emojiStart + 2)), [
    { jsonrpc: '2.0', method: 'echo', params: { text: '🙂' }, id: 1 },
    { jsonrpc: '2.0', method: 'notify' },
  ]);
  assert.deepEqual(framer.finish(), []);
});

test('framer ignores truly empty lines but rejects whitespace-only lines', () => {
  const framer = createJsonRpcFramer();

  assert.deepEqual(framer.push(encoder.encode('\n\r\n')), []);
  assertFailure('invalid_json', () => framer.push(encoder.encode('  \n')));
});

test('framer reports encoded frame overflow', () => {
  const framer = createJsonRpcFramer({ maxFrameBytes: 32 });

  assertFailure('overflow', () =>
    framer.push(encoder.encode('{"jsonrpc":"2.0","method":"message-too-large"}\n')),
  );

  const defaultLimit = createJsonRpcFramer();
  assertFailure('overflow', () => defaultLimit.push(new Uint8Array(1_048_577).fill(0x20)));
});

test('framer distinguishes invalid UTF-8, invalid JSON, and invalid message', () => {
  assertFailure('invalid_utf8', () => createJsonRpcFramer().push(Uint8Array.from([0xff, 0x0a])));
  assertFailure('invalid_json', () => createJsonRpcFramer().push(encoder.encode('{bad}\n')));
  assertFailure('invalid_message', () => createJsonRpcFramer().push(encoder.encode('[]\n')));
});

test('framer finish parses a valid final frame and rejects invalid or incomplete tails', () => {
  const valid = createJsonRpcFramer();
  valid.push(encoder.encode('{"jsonrpc":"2.0","method":"final"'));
  valid.push(encoder.encode(',"id":7}'));
  assert.deepEqual(valid.finish(), [{ jsonrpc: '2.0', method: 'final', id: 7 }]);

  const invalidJson = createJsonRpcFramer();
  invalidJson.push(encoder.encode('{"jsonrpc":"2.0"'));
  assertFailure('invalid_json', () => invalidJson.finish());

  const invalidUtf8 = createJsonRpcFramer();
  invalidUtf8.push(Uint8Array.from([0xe2, 0x82]));
  assertFailure('invalid_utf8', () => invalidUtf8.finish());

  const invalidMessage = createJsonRpcFramer();
  invalidMessage.push(encoder.encode('[]'));
  assertFailure('invalid_message', () => invalidMessage.finish());
});

test('framer latches its first fatal failure and rejects every later operation with it', () => {
  const cases: Array<{
    code: JsonRpcProtocolError['code'];
    create: () => ReturnType<typeof createJsonRpcFramer>;
    fail: (framer: ReturnType<typeof createJsonRpcFramer>) => unknown;
  }> = [
    {
      code: 'overflow',
      create: () => createJsonRpcFramer({ maxFrameBytes: 1 }),
      fail: (framer) => framer.push(encoder.encode('{}')),
    },
    {
      code: 'invalid_utf8',
      create: () => createJsonRpcFramer(),
      fail: (framer) => framer.push(Uint8Array.from([0xff])),
    },
    {
      code: 'invalid_json',
      create: () => createJsonRpcFramer(),
      fail: (framer) => framer.push(encoder.encode('{bad}\n')),
    },
    {
      code: 'invalid_message',
      create: () => createJsonRpcFramer(),
      fail: (framer) => framer.push(encoder.encode('[]\n')),
    },
  ];

  for (const entry of cases) {
    const framer = entry.create();
    let original: unknown;
    try {
      entry.fail(framer);
    } catch (error) {
      original = error;
    }
    assert.ok(original instanceof JsonRpcProtocolError);
    assert.equal(original.code, entry.code);
    assert.throws(() => framer.push(encoder.encode('{"jsonrpc":"2.0","method":"later"}\n')), (error) =>
      error === original,
    );
    assert.throws(() => framer.finish(), (error) => error === original);
  }
});

test('framer latches a failure originating from finish', () => {
  const framer = createJsonRpcFramer();
  framer.push(Uint8Array.from([0xe2, 0x82]));
  let original: unknown;
  try {
    framer.finish();
  } catch (error) {
    original = error;
  }

  assert.ok(original instanceof JsonRpcProtocolError);
  assert.equal(original.code, 'invalid_utf8');
  assert.throws(() => framer.push(encoder.encode('{}\n')), (error) => error === original);
  assert.throws(() => framer.finish(), (error) => error === original);
});
