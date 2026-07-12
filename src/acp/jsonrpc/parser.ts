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

function isJsonRpcValue(value: unknown): value is JsonRpcValue {
  type Frame = { kind: 'enter'; value: unknown; depth: number } | { kind: 'leave'; value: object };
  const ancestors = new WeakSet<object>();
  const stack: Frame[] = [{ kind: 'enter', value, depth: 1 }];
  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.kind === 'leave') {
        ancestors.delete(frame.value);
        continue;
      }
      const current = frame.value;
      if (frame.depth > 256) return false;
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
      if (typeof current === 'number') {
        if (!Number.isFinite(current)) return false;
        continue;
      }
      if (typeof current !== 'object') return false;
      if (!Array.isArray(current) && !isRecord(current)) return false;
      if (ancestors.has(current)) return false;
      ancestors.add(current);
      stack.push({ kind: 'leave', value: current });
      if (Array.isArray(current)) {
        for (let index = current.length - 1; index >= 0; index -= 1) {
          if (!hasOwn(current, String(index))) return false;
          stack.push({ kind: 'enter', value: current[index], depth: frame.depth + 1 });
        }
        continue;
      }
      const values = Object.values(current);
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'enter', value: values[index], depth: frame.depth + 1 });
      }
    }
  } catch {
    return false;
  }
  return true;
}

function isJsonRpcParams(value: unknown): value is JsonRpcParams {
  return (Array.isArray(value) || isRecord(value)) && isJsonRpcValue(value);
}

function invalidMessage(message: string, details?: unknown): JsonRpcProtocolError {
  return new JsonRpcProtocolError('invalid_message', message, details);
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  if (!isRecord(value) || !Number.isSafeInteger(value.code) ||
      typeof value.message !== 'string' || value.message.trim() === '') {
    throw invalidMessage('JSON-RPC error must contain a safe integer code and nonempty message', value);
  }
  if (hasOwn(value, 'data') && !isJsonRpcValue(value.data)) {
    throw invalidMessage('JSON-RPC error data must be a JSON value', value.data);
  }
  return {
    code: value.code as number,
    message: value.message,
    ...(hasOwn(value, 'data') ? { data: value.data as JsonRpcValue } : {}),
  };
}

function parseRequest(value: Record<string, unknown>): JsonRpcRequest | JsonRpcNotification {
  if (typeof value.method !== 'string' || value.method.trim() === '') {
    throw invalidMessage('JSON-RPC method must be a nonempty string', value.method);
  }
  if (hasOwn(value, 'params') && !isJsonRpcParams(value.params)) {
    throw invalidMessage('JSON-RPC params must be an object or array', value.params);
  }
  const base = {
    jsonrpc: '2.0' as const,
    method: value.method,
    ...(hasOwn(value, 'params') ? { params: value.params as JsonRpcParams } : {}),
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
    if (!isJsonRpcId(value.id) || !isJsonRpcValue(value.result)) {
      throw invalidMessage('JSON-RPC success response requires a correlatable id and JSON result', value);
    }
    return { jsonrpc: '2.0', id: value.id, result: value.result };
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
  if (!isRecord(value)) throw invalidMessage('JSON-RPC batch and non-object messages are not supported', value);
  if (value.jsonrpc !== '2.0') throw invalidMessage('JSON-RPC version must be 2.0', value.jsonrpc);
  if (hasOwn(value, 'method')) return parseRequest(value);
  return parseResponse(value);
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
