import { JsonRpcProtocolError } from './errors.js';
import type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcValue,
} from './types.js';

const MAX_JSON_DEPTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function snapshotRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

type JsonContainerEntries = {
  kind: 'array' | 'object';
  entries: Array<{ key: number | string; value: unknown }>;
};

function jsonContainerEntries(value: object): JsonContainerEntries | undefined {
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      return undefined;
    }
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1) return undefined;
    const entries: JsonContainerEntries['entries'] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      entries.push({ key: index, value: descriptor.value });
    }
    for (const key of keys) {
      if (typeof key !== 'string') return undefined;
      if (key === 'length') continue;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        return undefined;
      }
    }
    return { kind: 'array', entries };
  }
  if (!isRecord(value)) return undefined;
  const entries: JsonContainerEntries['entries'] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
    entries.push({ key, value: descriptor.value });
  }
  return { kind: 'object', entries };
}

function canonicalizeJsonRpcValue(value: unknown): JsonRpcValue | undefined {
  type Container = JsonRpcValue[] | { [key: string]: JsonRpcValue };
  type Frame =
    | { kind: 'enter'; value: unknown; depth: number; parent?: Container; key?: number | string }
    | { kind: 'leave'; value: object };
  const ancestors = new WeakSet<object>();
  const stack: Frame[] = [{ kind: 'enter', value, depth: 1 }];
  let result: JsonRpcValue | undefined;

  function assign(frame: Extract<Frame, { kind: 'enter' }>, canonical: JsonRpcValue): void {
    if (!frame.parent) {
      result = canonical;
      return;
    }
    if (Array.isArray(frame.parent)) {
      frame.parent[frame.key as number] = canonical;
      return;
    }
    Object.defineProperty(frame.parent, frame.key as string, {
      configurable: true,
      enumerable: true,
      value: canonical,
      writable: true,
    });
  }

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'leave') {
        ancestors.delete(frame.value);
        continue;
      }
      const current = frame.value;
      if (frame.depth > MAX_JSON_DEPTH) return undefined;
      if (current === null || typeof current === 'string' || typeof current === 'boolean') {
        assign(frame, current);
        continue;
      }
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return undefined;
        assign(frame, current);
        continue;
      }
      if (typeof current !== 'object') return undefined;
      const containerEntries = jsonContainerEntries(current);
      if (!containerEntries || ancestors.has(current)) return undefined;
      const canonical: Container = containerEntries.kind === 'array' ? [] : {};
      assign(frame, canonical);
      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      for (let index = containerEntries.entries.length - 1; index >= 0; index -= 1) {
        const entry = containerEntries.entries[index]!;
        stack.push({
          kind: 'enter',
          value: entry.value,
          depth: frame.depth + 1,
          parent: canonical,
          key: entry.key,
        });
      }
    }
  } catch {
    return undefined;
  }
  return result;
}

function canonicalizeJsonRpcParams(value: unknown): JsonRpcParams | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return canonicalizeJsonRpcValue(value) as JsonRpcParams | undefined;
}

function invalidMessage(message: string, details?: unknown): JsonRpcProtocolError {
  return new JsonRpcProtocolError('invalid_message', message, details);
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  const record = snapshotRecord(value);
  if (!record || !Number.isSafeInteger(record.code) ||
      typeof record.message !== 'string' || record.message.trim() === '') {
    throw invalidMessage('JSON-RPC error must contain a safe integer code and nonempty message', value);
  }
  const hasData = hasOwn(record, 'data');
  const data = hasData ? canonicalizeJsonRpcValue(record.data) : undefined;
  if (hasData && data === undefined) {
    throw invalidMessage('JSON-RPC error data must be a JSON value', record.data);
  }
  return {
    code: record.code as number,
    message: record.message,
    ...(hasData ? { data: data! } : {}),
  };
}

function parseRequest(value: Record<string, unknown>): JsonRpcRequest | JsonRpcNotification {
  if (typeof value.method !== 'string' || value.method.trim() === '') {
    throw invalidMessage('JSON-RPC method must be a nonempty string', value.method);
  }
  const hasParams = hasOwn(value, 'params');
  const params = hasParams ? canonicalizeJsonRpcParams(value.params) : undefined;
  if (hasParams && !params) {
    throw invalidMessage('JSON-RPC params must be an object or array', value.params);
  }
  const base = {
    jsonrpc: '2.0' as const,
    method: value.method,
    ...(hasParams ? { params: params! } : {}),
  };
  if (!hasOwn(value, 'id')) return base;
  if (!isJsonRpcId(value.id)) throw invalidMessage('JSON-RPC request id must be a string or safe integer', value.id);
  return { ...base, id: value.id };
}

function parseResponse(value: Record<string, unknown>): JsonRpcSuccessResponse | JsonRpcErrorResponse {
  if (!hasOwn(value, 'id')) throw invalidMessage('JSON-RPC response id is required', value);
  const hasResult = hasOwn(value, 'result');
  const hasError = hasOwn(value, 'error');
  if (hasResult === hasError) throw invalidMessage('JSON-RPC response requires exactly one of result or error', value);
  if (hasResult) {
    const result = canonicalizeJsonRpcValue(value.result);
    if (!isJsonRpcId(value.id) || result === undefined) {
      throw invalidMessage('JSON-RPC success response requires a correlatable id and JSON result', value);
    }
    return { jsonrpc: '2.0', id: value.id, result };
  }
  const error = parseErrorObject(value.error);
  if (value.id === null) {
    if (error.code !== -32700 && error.code !== -32600) {
      throw invalidMessage('Null response id is only valid for parse or invalid-request errors', value);
    }
    return { jsonrpc: '2.0', id: null, error };
  }
  if (!isJsonRpcId(value.id)) throw invalidMessage('JSON-RPC error response id must be null, string, or safe integer');
  return { jsonrpc: '2.0', id: value.id, error };
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const record = snapshotRecord(value);
  if (!record) throw invalidMessage('JSON-RPC batch and non-object messages are not supported', value);
  if (record.jsonrpc !== '2.0') throw invalidMessage('JSON-RPC version must be 2.0', record.jsonrpc);
  if (hasOwn(record, 'method')) return parseRequest(record);
  return parseResponse(record);
}

export function isJsonRpcRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

export function isJsonRpcNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

export function isJsonRpcResponse(
  message: JsonRpcMessage,
): message is JsonRpcSuccessResponse | JsonRpcErrorResponse {
  return !('method' in message);
}
