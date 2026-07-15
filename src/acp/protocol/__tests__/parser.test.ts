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
