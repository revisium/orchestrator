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

export function parseJsonRpcLine(line: string): JsonRpcMessage | undefined {
  if (line === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new JsonRpcProtocolError('invalid_json', 'JSON-RPC frame is not valid JSON', error);
  }
  return parseJsonRpcMessage(value);
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const record = snapshotJsonRpcRecord(value);
  if (!record) throw invalidJsonRpcMessage('JSON-RPC batch and non-object messages are not supported', value);
  if (!hasOwnField(record, 'jsonrpc') || record.jsonrpc !== '2.0') {
    throw invalidJsonRpcMessage('JSON-RPC version must be 2.0', record.jsonrpc);
  }
  if (hasOwnField(record, 'method')) return parseJsonRpcRequest(record);
  return parseJsonRpcResponse(record);
}

function hasOwnField(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function canonicalizeJsonRpcParams(value: unknown): JsonRpcParams | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return canonicalizeJsonRpcValue(value) as JsonRpcParams | undefined;
}

function invalidJsonRpcMessage(message: string, details?: unknown): JsonRpcProtocolError {
  return new JsonRpcProtocolError('invalid_message', message, details);
}

function parseJsonRpcErrorObject(value: unknown): JsonRpcErrorObject {
  const record = snapshotJsonRpcRecord(value);
  if (!record || !hasOwnField(record, 'code') || !hasOwnField(record, 'message') ||
      !Number.isSafeInteger(record.code) ||
      typeof record.message !== 'string' || record.message.trim() === '') {
    throw invalidJsonRpcMessage('JSON-RPC error must contain a safe integer code and nonempty message', value);
  }
  const hasData = hasOwnField(record, 'data');
  const data = hasData ? canonicalizeJsonRpcValue(record.data) : undefined;
  if (hasData && data === undefined) {
    throw invalidJsonRpcMessage('JSON-RPC error data must be a JSON value', record.data);
  }
  return isolateInheritedRuntimeHooks({
    code: record.code as number,
    message: record.message,
    ...(hasData ? { data: data! } : {}),
  });
}

function parseJsonRpcRequest(value: Record<string, unknown>): JsonRpcRequest | JsonRpcNotification {
  if (typeof value.method !== 'string' || value.method.trim() === '') {
    throw invalidJsonRpcMessage('JSON-RPC method must be a nonempty string', value.method);
  }
  const hasParams = hasOwnField(value, 'params');
  const params = hasParams ? canonicalizeJsonRpcParams(value.params) : undefined;
  if (hasParams && !params) {
    throw invalidJsonRpcMessage('JSON-RPC params must be an object or array', value.params);
  }
  const base = {
    jsonrpc: '2.0' as const,
    method: value.method,
    ...(hasParams ? { params: params! } : {}),
  };
  if (!hasOwnField(value, 'id')) return isolateInheritedRuntimeHooks(base);
  if (!isJsonRpcId(value.id)) throw invalidJsonRpcMessage('JSON-RPC request id must be a string or safe integer', value.id);
  return isolateInheritedRuntimeHooks({ ...base, id: value.id });
}

function parseJsonRpcResponse(value: Record<string, unknown>): JsonRpcSuccessResponse | JsonRpcErrorResponse {
  if (!hasOwnField(value, 'id')) throw invalidJsonRpcMessage('JSON-RPC response id is required', value);
  const hasResult = hasOwnField(value, 'result');
  const hasError = hasOwnField(value, 'error');
  if (hasResult === hasError) throw invalidJsonRpcMessage('JSON-RPC response requires exactly one of result or error', value);
  if (hasResult) {
    const result = canonicalizeJsonRpcValue(value.result);
    if (!isJsonRpcId(value.id) || result === undefined) {
      throw invalidJsonRpcMessage('JSON-RPC success response requires a correlatable id and JSON result', value);
    }
    return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: value.id, result });
  }
  const error = parseJsonRpcErrorObject(value.error);
  if (value.id === null) {
    if (error.code !== -32700 && error.code !== -32600) {
      throw invalidJsonRpcMessage('Null response id is only valid for parse or invalid-request errors', value);
    }
    return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: null, error });
  }
  if (!isJsonRpcId(value.id)) throw invalidJsonRpcMessage('JSON-RPC error response id must be null, string, or safe integer');
  return isolateInheritedRuntimeHooks({ jsonrpc: '2.0', id: value.id, error });
}
