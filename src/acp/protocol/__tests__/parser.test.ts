import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACP_METHODS,
  buildAcpCloseSessionParams,
  buildAcpInitializeParams,
  buildAcpNewSessionParams,
  buildAcpPermissionResult,
  buildAcpPromptParams,
  buildAcpSetSessionConfigOptionParams,
} from '../methods.js';
import type { JsonRpcParams, JsonRpcValue } from '../../jsonrpc/types.js';
import type {
  AcpInitializeRequest,
  AcpSessionUpdateDiscriminator,
  AcpSetSessionConfigOptionRequest,
} from '../values.js';
import { AcpProtocolError } from '../error.js';
import {
  parseAcpCloseSessionResponse,
  parseAcpInitializeResponse,
  parseAcpPeerNotification,
  parseAcpPeerRequest,
  parseAcpPromptResponse,
  parseAcpSessionNewResponse,
  parseAcpSetSessionConfigOptionResponse,
} from '../parser.js';

const UPDATE_DISCRIMINATORS: readonly AcpSessionUpdateDiscriminator[] = [
  'user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk',
  'tool_call', 'tool_call_update', 'plan', 'available_commands_update',
  'current_mode_update', 'config_option_update', 'session_info_update', 'usage_update',
];

test('defines the seven ACP v1 methods exactly', () => {
  assert.deepEqual(ACP_METHODS, {
    initialize: 'initialize',
    newSession: 'session/new',
    setSessionConfigOption: 'session/set_config_option',
    prompt: 'session/prompt',
    closeSession: 'session/close',
    requestPermission: 'session/request_permission',
    sessionUpdate: 'session/update',
  });
});

test('builds exact client-side boolean capability as a fresh mutable JSON-RPC value', () => {
  const request: AcpInitializeRequest = {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      session: { configOptions: { boolean: {} } },
      terminal: false,
    },
    clientInfo: { name: 'revo', version: '1.0.0' },
  };
  const params: JsonRpcParams = buildAcpInitializeParams(request);
  assert.deepEqual(params, request);
  assert.notEqual(params, request);
  const session = (params as { session?: unknown }).session;
  assert.equal(session, undefined);
  assert.deepEqual(
    (params as { clientCapabilities: { session: { configOptions: { boolean: unknown } } } })
      .clientCapabilities.session.configOptions.boolean,
    {},
  );
});

function initializeRequestWithBoolean(
  booleanCapabilities: unknown,
): AcpInitializeRequest {
  return {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      session: { configOptions: { boolean: booleanCapabilities } },
      terminal: false,
    },
    clientInfo: { name: 'revo', version: '1.0.0' },
  } as unknown as AcpInitializeRequest;
}

test('copies absent, null and canonical boolean capability metadata', () => {
  const canonicalMeta = { z: [1, { nested: true }], a: 'stable' };
  const absent = buildAcpInitializeParams(initializeRequestWithBoolean({}));
  const nullable = buildAcpInitializeParams(initializeRequestWithBoolean({ _meta: null }));
  const canonical = buildAcpInitializeParams(initializeRequestWithBoolean({ _meta: canonicalMeta }));
  const absentBoolean = (absent as {
    clientCapabilities: { session: { configOptions: { boolean: Record<string, unknown> } } };
  }).clientCapabilities.session.configOptions.boolean;
  const nullableBoolean = (nullable as {
    clientCapabilities: { session: { configOptions: { boolean: Record<string, unknown> } } };
  }).clientCapabilities.session.configOptions.boolean;
  const canonicalBoolean = (canonical as {
    clientCapabilities: { session: { configOptions: { boolean: { _meta: unknown } } } };
  }).clientCapabilities.session.configOptions.boolean;
  assert.equal(Object.hasOwn(absentBoolean, '_meta'), false);
  assert.deepEqual(nullableBoolean, { _meta: null });
  assert.deepEqual(canonicalBoolean, { _meta: canonicalMeta });
  assert.notEqual(canonicalBoolean._meta, canonicalMeta);
  canonicalMeta.z[1] = { nested: false };
  assert.deepEqual(canonicalBoolean, {
    _meta: { z: [1, { nested: true }], a: 'stable' },
  });
});

test('rejects inherited, accessor and toJSON metadata without executing user code', () => {
  let getterCalls = 0;
  let toJsonCalls = 0;
  const inherited = Object.create({ _meta: { inherited: true } });
  const accessor = {};
  Object.defineProperty(accessor, '_meta', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not execute');
    },
  });
  const customSerialization = {
    _meta: {
      stable: true,
      toJSON() {
        toJsonCalls += 1;
        return { replaced: true };
      },
    },
  };
  for (const booleanCapabilities of [inherited, accessor, customSerialization]) {
    assert.throws(
      () => buildAcpInitializeParams(initializeRequestWithBoolean(booleanCapabilities)),
      TypeError,
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(toJsonCalls, 0);
});

test('every builder is directly assignable to mutable JSON-RPC types', () => {
  const newSession: JsonRpcParams = buildAcpNewSessionParams({ cwd: '/repo', mcpServers: [] });
  const select: JsonRpcParams = buildAcpSetSessionConfigOptionParams({
    sessionId: 'session-1', configId: 'model', value: 'provider/model',
  });
  const boolean: JsonRpcParams = buildAcpSetSessionConfigOptionParams({
    sessionId: 'session-1', configId: 'thinking', type: 'boolean', value: true,
  });
  const prompt: JsonRpcParams = buildAcpPromptParams({
    sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }],
  });
  const close: JsonRpcParams = buildAcpCloseSessionParams({ sessionId: 'session-1' });
  const permission: JsonRpcValue = buildAcpPermissionResult({
    outcome: { outcome: 'selected', optionId: 'allow-once' },
  });
  assert.deepEqual({ newSession, select, boolean, prompt, close, permission }, {
    newSession: { cwd: '/repo', mcpServers: [] },
    select: { sessionId: 'session-1', configId: 'model', value: 'provider/model' },
    boolean: { sessionId: 'session-1', configId: 'thinking', type: 'boolean', value: true },
    prompt: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] },
    close: { sessionId: 'session-1' },
    permission: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
  });
});

test('models exactly eleven update discriminators and both config request forms', () => {
  const requests: readonly AcpSetSessionConfigOptionRequest[] = [
    { sessionId: 's', configId: 'model', value: 'p/m' },
    { sessionId: 's', configId: 'thinking', type: 'boolean', value: false },
  ];
  assert.equal(new Set(UPDATE_DISCRIMINATORS).size, 11);
  assert.deepEqual(requests.map(buildAcpSetSessionConfigOptionParams), [
    { sessionId: 's', configId: 'model', value: 'p/m' },
    { sessionId: 's', configId: 'thinking', type: 'boolean', value: false },
  ]);
});

function assertProtocolCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof AcpProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test('parses nullable initialize fields and exact agent close capability', () => {
  assert.deepEqual(parseAcpInitializeResponse({
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { close: {} } },
    agentInfo: { name: 'agent', version: '1', title: null },
  }), {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { close: {} } },
    agentInfo: { name: 'agent', version: '1' },
  });
  assert.deepEqual(parseAcpInitializeResponse({ protocolVersion: 1, agentInfo: null }), {
    protocolVersion: 1,
  });
  assertProtocolCode(
    () => parseAcpInitializeResponse({ protocolVersion: 2 }),
    'unsupported_protocol_version',
  );
});

test('distinguishes optional new-session config from required set-config response', () => {
  assert.deepEqual(parseAcpSessionNewResponse({ sessionId: 's' }), { sessionId: 's' });
  assert.deepEqual(parseAcpSessionNewResponse({ sessionId: 's', configOptions: null }), {
    sessionId: 's', configOptions: null,
  });
  assertProtocolCode(
    () => parseAcpSetSessionConfigOptionResponse({ configOptions: null }),
    'invalid_config_option_response',
  );
});

const RESPONSE_FAILURES = [
  ['initialize', () => parseAcpInitializeResponse(null), 'invalid_initialize_response'],
  ['session/new', () => parseAcpSessionNewResponse({ sessionId: '' }), 'invalid_session_new_response'],
  ['set config', () => parseAcpSetSessionConfigOptionResponse({}), 'invalid_config_option_response'],
  ['prompt', () => parseAcpPromptResponse({ stopReason: 'unknown' }), 'invalid_prompt_response'],
  ['close', () => parseAcpCloseSessionResponse([]), 'invalid_close_response'],
] as const;

for (const [name, operation, code] of RESPONSE_FAILURES) {
  test(`rejects malformed ${name} with its owned protocol reason`, () => {
    assertProtocolCode(operation, code);
  });
}

const UPDATE_CASES = [
  [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'user' } }, 'activity'],
  [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'agent' } }, 'agent-text'],
  [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } }, 'activity'],
  [{ sessionUpdate: 'tool_call', toolCallId: 't', title: 'Tool' }, 'activity'],
  [{ sessionUpdate: 'tool_call_update', toolCallId: 't' }, 'activity'],
  [{ sessionUpdate: 'plan', entries: [{}] }, 'activity'],
  [{ sessionUpdate: 'available_commands_update', availableCommands: [{}] }, 'activity'],
  [{ sessionUpdate: 'current_mode_update', currentModeId: 'mode' }, 'activity'],
  [{ sessionUpdate: 'config_option_update', configOptions: [] }, 'activity'],
  [{ sessionUpdate: 'session_info_update', title: null, updatedAt: null }, 'activity'],
  [{ sessionUpdate: 'usage_update', used: 3, size: 5, cost: { amount: 0.25, currency: 'USD' } }, 'usage'],
] satisfies readonly [JsonRpcValue, 'activity' | 'agent-text' | 'usage'][];

test('parses exactly all eleven ACP update discriminators', () => {
  const parsed = UPDATE_CASES.map(([update]) => parseAcpPeerNotification({
    method: 'session/update',
    params: { sessionId: 'session-1', update },
  }));
  assert.equal(parsed.length, 11);
  assert.deepEqual(parsed.map(({ update }) => update.kind), UPDATE_CASES.map(([, kind]) => kind));
});

test('returns typed config options from config_option_update', () => {
  const notification = parseAcpPeerNotification({
    method: 'session/update',
    params: {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{
          id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true,
        }],
      },
    },
  });
  assert.equal(notification.update.kind, 'activity');
  if (notification.update.kind === 'activity' &&
      notification.update.activityKind === 'config_option_update') {
    assert.deepEqual(notification.update.configOptions, [{
      id: 'thinking', name: 'Thinking', type: 'boolean', currentValue: true,
    }]);
  } else {
    assert.fail('Expected typed config_option_update');
  }
});

const NON_TEXT_CONTENT = [
  { type: 'image', data: 'base64', mimeType: 'image/png' },
  { type: 'audio', data: 'base64', mimeType: 'audio/wav' },
  { type: 'resource_link', uri: 'file:///repo/a', name: 'a' },
  { type: 'resource', resource: { uri: 'file:///repo/a', text: 'a' } },
] as const;

test('maps valid non-text agent messages to canonical activity', () => {
  for (const content of NON_TEXT_CONTENT) {
    const notification = parseAcpPeerNotification({
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: { sessionUpdate: 'agent_message_chunk', content },
      },
    });
    assert.equal(notification.update.kind, 'activity');
    if (notification.update.kind === 'activity') {
      assert.equal(notification.update.activityKind, 'agent_message_chunk');
      assert.notEqual(notification.update.snapshot, content);
    }
  }
});

test('rejects unknown methods, updates and malformed permissions before consumers', () => {
  assertProtocolCode(
    () => parseAcpPeerRequest({ jsonrpc: '2.0', id: 1, method: 'unknown', params: {} }),
    'unsupported_peer_request',
  );
  assertProtocolCode(
    () => parseAcpPeerNotification({
      method: 'session/update',
      params: { sessionId: 's', update: { sessionUpdate: 'unknown' } },
    }),
    'unsupported_session_update',
  );
  assertProtocolCode(
    () => parseAcpPeerRequest({
      jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {},
    }),
    'malformed_peer_request',
  );
});

function hostileValue(value: unknown): JsonRpcValue {
  return value as JsonRpcValue;
}

test('rejects inherited and accessor fields without evaluating user code', () => {
  let getterCalls = 0;
  const inherited = Object.create({ protocolVersion: 1 });
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, 'protocolVersion', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('must not execute');
    },
  });

  assertProtocolCode(
    () => parseAcpInitializeResponse(hostileValue(inherited)),
    'invalid_initialize_response',
  );
  assertProtocolCode(
    () => parseAcpInitializeResponse(hostileValue(accessor)),
    'invalid_initialize_response',
  );
  assert.equal(getterCalls, 0);
});

test('rejects throwing proxy, toJSON and cycle without coercion or callbacks', () => {
  let toJsonCalls = 0;
  const throwingProxy = new Proxy({}, {
    ownKeys() {
      throw new Error('must be contained');
    },
  });
  const customJson = {
    protocolVersion: 1,
    agentCapabilities: {
      sessionCapabilities: {
        close: {
          _meta: {
            toJSON() {
              toJsonCalls += 1;
              return {};
            },
          },
        },
      },
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;

  assertProtocolCode(
    () => parseAcpInitializeResponse(hostileValue(throwingProxy)),
    'invalid_initialize_response',
  );
  assertProtocolCode(
    () => parseAcpInitializeResponse(hostileValue(customJson)),
    'invalid_initialize_response',
  );
  assertProtocolCode(
    () => parseAcpCloseSessionResponse(hostileValue({ _meta: cycle })),
    'invalid_close_response',
  );
  assert.equal(toJsonCalls, 0);
});

test('rejects mixed config options, unsafe usage, non-finite cost and empty IDs', () => {
  const mixedOptions = [{ value: 'a', name: 'A' }, {
    group: 'models',
    name: 'Models',
    options: [{ value: 'b', name: 'B' }],
  }];
  assertProtocolCode(
    () => parseAcpSetSessionConfigOptionResponse(hostileValue({
      configOptions: [{
        id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: mixedOptions,
      }],
    })),
    'invalid_config_option_response',
  );
  assertProtocolCode(
    () => parseAcpPeerNotification({
      method: 'session/update',
      params: {
        sessionId: 's',
        update: { sessionUpdate: 'usage_update', used: Number.MAX_SAFE_INTEGER + 1, size: 1 },
      },
    }),
    'malformed_peer_notification',
  );
  assertProtocolCode(
    () => parseAcpPeerNotification({
      method: 'session/update',
      params: {
        sessionId: 's',
        update: {
          sessionUpdate: 'usage_update', used: 1, size: 1,
          cost: { amount: Number.POSITIVE_INFINITY, currency: 'USD' },
        },
      },
    }),
    'malformed_peer_notification',
  );
  assertProtocolCode(
    () => parseAcpSessionNewResponse({ sessionId: '' }),
    'invalid_session_new_response',
  );
  assertProtocolCode(
    () => parseAcpPeerRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/request_permission',
      params: {
        sessionId: 's', toolCall: { toolCallId: '' },
        options: [{ optionId: '', name: 'Allow', kind: 'allow_once' }],
      },
    }),
    'malformed_peer_request',
  );
});
