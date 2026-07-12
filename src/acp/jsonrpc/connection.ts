import type { AcpTransportWrite } from '../types/execution.js';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JsonRpcProtocolError,
  parseJsonRpcMessage,
  type JsonRpcErrorObject,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcParams,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type JsonRpcValue,
} from './types.js';

export type JsonRpcServerRequestOutcome =
  | { kind: 'result'; value: JsonRpcValue }
  | { kind: 'error'; error: JsonRpcErrorObject };

export type JsonRpcConnectionDeps = {
  write: AcpTransportWrite;
  onRequest?: (request: JsonRpcRequest) => Promise<JsonRpcServerRequestOutcome>;
  onNotification?: (notification: { method: string; params?: JsonRpcParams }) => Promise<void>;
};

export type JsonRpcConnection = {
  request(method: string, params?: JsonRpcParams): Promise<JsonRpcValue>;
  notify(method: string, params?: JsonRpcParams): Promise<void>;
  receive(message: JsonRpcMessage): Promise<void>;
  close(): void;
};

type PendingRequest = {
  resolve(value: JsonRpcValue): void;
  reject(error: unknown): void;
};

const encoder = new TextEncoder();

function encode(message: JsonRpcMessage): Uint8Array {
  return encoder.encode(`${JSON.stringify(parseJsonRpcMessage(message))}\n`);
}

function requestMessage(method: string, params: JsonRpcParams | undefined, id: JsonRpcId): JsonRpcRequest {
  return parseJsonRpcMessage({
    jsonrpc: '2.0',
    method,
    ...(params === undefined ? {} : { params }),
    id,
  }) as JsonRpcRequest;
}

export function createJsonRpcConnection(deps: JsonRpcConnectionDeps): JsonRpcConnection {
  const pending = new Map<JsonRpcId, PendingRequest>();
  const settled = new Set<JsonRpcId>();
  let nextId = 1;
  let closed = false;

  function ensureOpen(): void {
    if (closed) throw new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
  }

  async function write(message: JsonRpcMessage): Promise<void> {
    try {
      await deps.write(encode(message));
    } catch (error) {
      throw new JsonRpcProtocolError('send_failed', 'JSON-RPC transport write failed', error);
    }
  }

  function receiveResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (message.id === null) {
      throw new JsonRpcProtocolError('uncorrelated_null_response', 'Null JSON-RPC response id cannot be correlated');
    }
    const call = pending.get(message.id);
    if (!call) {
      const code = settled.has(message.id) ? 'duplicate_response_id' : 'unknown_response_id';
      throw new JsonRpcProtocolError(code, `Unexpected JSON-RPC response id ${String(message.id)}`);
    }
    pending.delete(message.id);
    settled.add(message.id);
    if ('result' in message) {
      call.resolve(message.result);
      return;
    }
    call.reject(new JsonRpcProtocolError('remote_error', message.error.message, message.error));
  }

  return {
    request(method, params): Promise<JsonRpcValue> {
      ensureOpen();
      if (!Number.isSafeInteger(nextId)) {
        throw new JsonRpcProtocolError('request_id_exhausted', 'JSON-RPC request id space is exhausted');
      }
      const id = nextId;
      const message = requestMessage(method, params, id);
      nextId += 1;
      const result = new Promise<JsonRpcValue>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      void write(message).catch((error: unknown) => {
        const call = pending.get(id);
        if (call) {
          pending.delete(id);
          call.reject(error);
        }
      });
      return result;
    },
    async notify(method, params): Promise<void> {
      ensureOpen();
      const message = parseJsonRpcMessage({
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
      });
      await write(message);
    },
    async receive(message): Promise<void> {
      ensureOpen();
      const valid = parseJsonRpcMessage(message);
      if (isJsonRpcResponse(valid)) {
        receiveResponse(valid);
        return;
      }
      if (isJsonRpcRequest(valid) || isJsonRpcNotification(valid)) {
        throw new JsonRpcProtocolError('handler_failed', 'Inbound JSON-RPC request handlers are not configured');
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      const error = new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
      for (const call of pending.values()) call.reject(error);
      pending.clear();
    },
  };
}
