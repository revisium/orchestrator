export type JsonRpcPrimitive = null | boolean | number | string;
export type JsonRpcValue = JsonRpcPrimitive | JsonRpcValue[] | { [key: string]: JsonRpcValue };
export type JsonRpcParams = JsonRpcValue[] | { [key: string]: JsonRpcValue };
export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
  id: JsonRpcId;
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: JsonRpcParams;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: JsonRpcValue;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: JsonRpcValue;
};

export type JsonRpcErrorResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
};

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse;

export type JsonRpcProtocolFailureCode =
  | 'overflow'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_message'
  | 'unknown_response_id'
  | 'duplicate_response_id'
  | 'uncorrelated_null_response'
  | 'request_id_exhausted'
  | 'remote_error'
  | 'send_failed'
  | 'handler_failed'
  | 'closed';

export class JsonRpcProtocolError extends Error {
  constructor(
    readonly code: JsonRpcProtocolFailureCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcProtocolError';
  }
}

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
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return isJsonRpcArray(value);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonRpcValue);
}

function isJsonRpcArray(value: unknown[]): value is JsonRpcValue[] {
  for (let index = 0; index < value.length; index += 1) {
    if (!hasOwn(value, String(index)) || !isJsonRpcValue(value[index])) return false;
  }
  return true;
}

function isJsonRpcParams(value: unknown): value is JsonRpcParams {
  return (Array.isArray(value) && isJsonRpcArray(value)) ||
    (isRecord(value) && Object.values(value).every(isJsonRpcValue));
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
