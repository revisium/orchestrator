import {
  canonicalizeJsonRpcValue,
  isolateInheritedRuntimeHooks,
  snapshotJsonRpcRecord,
} from './canonicalizer.js';
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
} from './types.js';

function hasOwn(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function canonicalizeJsonRpcParams(value: unknown): JsonRpcParams | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return canonicalizeJsonRpcValue(value) as JsonRpcParams | undefined;
}

function invalidMessage(message: string, details?: unknown): JsonRpcProtocolError {
  return new JsonRpcProtocolError('invalid_message', message, details);
}

function parseErrorObject(value: unknown): JsonRpcErrorObject {
  const record = snapshotJsonRpcRecord(value);
  if (!record || !hasOwn(record, 'code') || !hasOwn(record, 'message') ||
      !Number.isSafeInteger(record.code) ||
      typeof record.message !== 'string' || record.message.trim() === '') {
    throw invalidMessage('JSON-RPC error must contain a safe integer code and nonempty message', value);
  }
  const hasData = hasOwn(record, 'data');
  const data = hasData ? canonicalizeJsonRpcValue(record.data) : undefined;
  if (hasData && data === undefined) {
    throw invalidMessage('JSON-RPC error data must be a JSON value', record.data);
  }
  return isolateInheritedRuntimeHooks({
    code: record.code as number,
    message: record.message,
    ...(hasData ? { data: data! } : {}),
  });
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
  if (!hasOwn(value, 'id')) return isolateInheritedRuntimeHooks(base);
  if (!isJsonRpcId(value.id)) throw invalidMessage('JSON-RPC request id must be a string or safe integer', value.id);
  return isolateInheritedRuntimeHooks({ ...base, id: value.id });
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
    return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: value.id, result });
  }
  const error = parseErrorObject(value.error);
  if (value.id === null) {
    if (error.code !== -32700 && error.code !== -32600) {
      throw invalidMessage('Null response id is only valid for parse or invalid-request errors', value);
    }
    return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: null, error });
  }
  if (!isJsonRpcId(value.id)) throw invalidMessage('JSON-RPC error response id must be null, string, or safe integer');
  return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: value.id, error });
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const record = snapshotJsonRpcRecord(value);
  if (!record) throw invalidMessage('JSON-RPC batch and non-object messages are not supported', value);
  if (!hasOwn(record, 'jsonrpc') || record.jsonrpc !== '2.0') {
    throw invalidMessage('JSON-RPC version must be 2.0', record.jsonrpc);
  }
  if (hasOwn(record, 'method')) return parseRequest(record);
  return parseResponse(record);
}
