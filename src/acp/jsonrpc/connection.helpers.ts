import { parseJsonRpcMessage } from './parser.js';
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from './types.js';

const encoder = new TextEncoder();

export function encodeJsonRpcMessage(message: JsonRpcMessage): Uint8Array {
  const jsonRpcMessage = parseJsonRpcMessage(message);
  return encoder.encode(`${JSON.stringify(jsonRpcMessage)}\n`);
}

export function createJsonRpcRequest(method: string, params: JsonRpcParams | undefined, id: JsonRpcId): JsonRpcRequest {
  return parseJsonRpcMessage({
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
    id,
  }) as JsonRpcRequest;
}

export function isJsonRpcMethodMessage(message: JsonRpcMessage): message is JsonRpcRequest | JsonRpcNotification {
  return Object.hasOwn(message, 'method');
}

export function isJsonRpcRequestMessage(message: JsonRpcMessage): message is JsonRpcRequest {
  return Object.hasOwn(message, 'id');
}

export function isJsonRpcSuccessResponse(message: JsonRpcMessage): message is JsonRpcSuccessResponse {
  return Object.hasOwn(message, 'result');
}
