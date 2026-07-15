import {
  canonicalizeJsonRpcValue,
  snapshotJsonRpcRecord,
} from '../jsonrpc/canonicalizer.js';
import type { JsonRpcParams, JsonRpcValue } from '../jsonrpc/types.js';
import type {
  AcpCloseSessionRequest,
  AcpInitializeRequest,
  AcpNewSessionRequest,
  AcpPermissionResponse,
  AcpPromptRequest,
  AcpSetSessionConfigOptionRequest,
} from './values.js';

export const ACP_PROTOCOL_VERSION = 1 as const;
export const ACP_METHODS = {
  initialize: 'initialize',
  newSession: 'session/new',
  setSessionConfigOption: 'session/set_config_option',
  prompt: 'session/prompt',
  closeSession: 'session/close',
  requestPermission: 'session/request_permission',
  sessionUpdate: 'session/update',
} as const;
export type AcpMethod = (typeof ACP_METHODS)[keyof typeof ACP_METHODS];

function invalidBuilderValue(path: string): never {
  throw new TypeError(`ACP builder requires canonical ${path}`);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  const record = snapshotJsonRpcRecord(value);
  return record ?? invalidBuilderValue(path);
}

function requireOwn(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(record, key)) invalidBuilderValue(`${path}.${key}`);
  return record[key];
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string {
  const field = requireOwn(record, key, path);
  return typeof field === 'string' ? field : invalidBuilderValue(`${path}.${key}`);
}

function copyOptionalMeta(
  owner: Record<string, unknown>,
  path: string,
): Readonly<{ _meta?: JsonRpcValue }> {
  if (!Object.hasOwn(owner, '_meta')) return {};
  const rawMeta = owner['_meta'];
  if (rawMeta === null) return { _meta: null };
  const canonicalMeta = canonicalizeJsonRpcValue(rawMeta);
  if (
    canonicalMeta === undefined ||
    canonicalMeta === null ||
    Array.isArray(canonicalMeta) ||
    typeof canonicalMeta !== 'object'
  ) {
    invalidBuilderValue(`${path}._meta`);
  }
  return { _meta: canonicalMeta };
}

function copyImplementation(
  rawImplementation: unknown,
  path: string,
): Record<string, JsonRpcValue> {
  const implementation = requireRecord(rawImplementation, path);
  const name = requireString(implementation, 'name', path);
  const version = requireString(implementation, 'version', path);
  const title = implementation['title'];
  if (Object.hasOwn(implementation, 'title') && typeof title !== 'string') {
    invalidBuilderValue(`${path}.title`);
  }
  return {
    name,
    version,
    ...(typeof title === 'string' ? { title } : {}),
  };
}

export function buildAcpInitializeParams(request: AcpInitializeRequest): JsonRpcParams {
  const initializeRequest = requireRecord(request, 'initialize');
  const protocolVersion = requireOwn(initializeRequest, 'protocolVersion', 'initialize');
  if (protocolVersion !== ACP_PROTOCOL_VERSION) invalidBuilderValue('initialize.protocolVersion');
  const clientCapabilities = requireRecord(
    requireOwn(initializeRequest, 'clientCapabilities', 'initialize'),
    'initialize.clientCapabilities',
  );
  const fs = requireRecord(
    requireOwn(clientCapabilities, 'fs', 'initialize.clientCapabilities'),
    'initialize.clientCapabilities.fs',
  );
  if (
    requireOwn(fs, 'readTextFile', 'initialize.clientCapabilities.fs') !== false ||
    requireOwn(fs, 'writeTextFile', 'initialize.clientCapabilities.fs') !== false
  ) {
    invalidBuilderValue('initialize.clientCapabilities.fs');
  }
  const clientSession = requireRecord(
    requireOwn(clientCapabilities, 'session', 'initialize.clientCapabilities'),
    'initialize.clientCapabilities.session',
  );
  const configOptions = requireRecord(
    requireOwn(clientSession, 'configOptions', 'initialize.clientCapabilities.session'),
    'initialize.clientCapabilities.session.configOptions',
  );
  const booleanCapabilities = Object.hasOwn(configOptions, 'boolean')
    ? requireRecord(
        configOptions['boolean'],
        'initialize.clientCapabilities.session.configOptions.boolean',
      )
    : undefined;
  if (requireOwn(clientCapabilities, 'terminal', 'initialize.clientCapabilities') !== false) {
    invalidBuilderValue('initialize.clientCapabilities.terminal');
  }
  const clientInfo = copyImplementation(
    requireOwn(initializeRequest, 'clientInfo', 'initialize'),
    'initialize.clientInfo',
  );
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      session: {
        configOptions: {
          ...(booleanCapabilities === undefined
            ? {}
            : { boolean: copyOptionalMeta(
                booleanCapabilities,
                'initialize.clientCapabilities.session.configOptions.boolean',
              ) }),
        },
      },
      terminal: false,
    },
    clientInfo,
  };
}

export function buildAcpNewSessionParams({ cwd }: AcpNewSessionRequest): JsonRpcParams {
  return { cwd, mcpServers: [] };
}

export function buildAcpSetSessionConfigOptionParams(
  request: AcpSetSessionConfigOptionRequest,
): JsonRpcParams {
  const { sessionId, configId, value } = request;
  return 'type' in request
    ? { sessionId, configId, type: 'boolean', value }
    : { sessionId, configId, value };
}

export function buildAcpPromptParams({ sessionId, prompt }: AcpPromptRequest): JsonRpcParams {
  const [{ text }] = prompt;
  return { sessionId, prompt: [{ type: 'text', text }] };
}

export function buildAcpCloseSessionParams({ sessionId }: AcpCloseSessionRequest): JsonRpcParams {
  return { sessionId };
}

export function buildAcpPermissionResult({ outcome }: AcpPermissionResponse): JsonRpcValue {
  return outcome.outcome === 'selected'
    ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
