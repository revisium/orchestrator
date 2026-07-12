import type { AcpTransportWrite } from '../types/execution.js';
import { JsonRpcProtocolError } from './errors.js';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseJsonRpcMessage,
} from './parser.js';
import type {
  JsonRpcErrorObject,
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcValue,
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

type QueuedWrite = {
  chunk: Uint8Array;
  resolve(): void;
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

class JsonRpcConnectionImpl implements JsonRpcConnection {
  readonly #deps: JsonRpcConnectionDeps;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #recentResponses = new Set<JsonRpcId>();
  readonly #writeQueue: QueuedWrite[] = [];
  #nextId = 1;
  #closed = false;
  #writing = false;

  constructor(deps: JsonRpcConnectionDeps) {
    this.#deps = deps;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
  }

  #drainWrites(): void {
    if (this.#writing) return;
    const queued = this.#writeQueue.shift();
    if (!queued) return;
    if (this.#closed) {
      queued.reject(new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed'));
      this.#drainWrites();
      return;
    }
    this.#writing = true;
    let sent: Promise<void>;
    try {
      sent = this.#deps.write(queued.chunk);
    } catch (error) {
      sent = Promise.reject(error);
    }
    void sent.then(
      () => {
        queued.resolve();
        this.#writing = false;
        this.#drainWrites();
      },
      (error: unknown) => {
        queued.reject(new JsonRpcProtocolError('send_failed', 'JSON-RPC transport write failed', error));
        this.#writing = false;
        this.#drainWrites();
      },
    );
  }

  #write(message: JsonRpcMessage): Promise<void> {
    this.#ensureOpen();
    const chunk = encode(message);
    const operation = new Promise<void>((resolve, reject) => {
      this.#writeQueue.push({ chunk, resolve, reject });
    });
    this.#drainWrites();
    return operation;
  }

  #rememberResponse(id: JsonRpcId): void {
    this.#recentResponses.add(id);
    if (this.#recentResponses.size <= 1_024) return;
    const oldest = this.#recentResponses.values().next().value as JsonRpcId;
    this.#recentResponses.delete(oldest);
  }

  #receiveResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (message.id === null) {
      throw new JsonRpcProtocolError('uncorrelated_null_response', 'Null JSON-RPC response id cannot be correlated');
    }
    const call = this.#pending.get(message.id);
    if (!call) {
      const code = this.#recentResponses.has(message.id) ? 'duplicate_response_id' : 'unknown_response_id';
      throw new JsonRpcProtocolError(code, `Unexpected JSON-RPC response id ${String(message.id)}`);
    }
    this.#pending.delete(message.id);
    this.#rememberResponse(message.id);
    if ('result' in message) {
      call.resolve(message.result);
      return;
    }
    call.reject(new JsonRpcProtocolError('remote_error', message.error.message, message.error));
  }

  async #receiveRequest(message: JsonRpcRequest): Promise<void> {
    let response: JsonRpcMessage;
    try {
      const outcome: JsonRpcServerRequestOutcome = this.#deps.onRequest
        ? await this.#deps.onRequest(message)
        : { kind: 'error', error: { code: -32601, message: 'Method not found' } };
      response = outcome.kind === 'result'
        ? parseJsonRpcMessage({ jsonrpc: '2.0', id: message.id, result: outcome.value })
        : parseJsonRpcMessage({ jsonrpc: '2.0', id: message.id, error: outcome.error });
    } catch {
      response = parseJsonRpcMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'Internal error' },
      });
    }
    await this.#write(response);
  }

  async #receiveNotification(message: Extract<JsonRpcMessage, { method: string }>): Promise<void> {
    if (!this.#deps.onNotification) return;
    try {
      await this.#deps.onNotification({
        method: message.method,
        ...('params' in message ? { params: message.params } : {}),
      });
    } catch (error) {
      throw new JsonRpcProtocolError('handler_failed', 'JSON-RPC notification handler failed', error);
    }
  }

  request(method: string, params?: JsonRpcParams): Promise<JsonRpcValue> {
    this.#ensureOpen();
    if (!Number.isSafeInteger(this.#nextId)) {
      throw new JsonRpcProtocolError('request_id_exhausted', 'JSON-RPC request id space is exhausted');
    }
    const id = this.#nextId;
    const message = requestMessage(method, params, id);
    this.#nextId += 1;
    const result = new Promise<JsonRpcValue>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    void this.#write(message).catch((error: unknown) => {
      const call = this.#pending.get(id);
      if (call) {
        this.#pending.delete(id);
        call.reject(error);
      }
    });
    return result;
  }

  async notify(method: string, params?: JsonRpcParams): Promise<void> {
    this.#ensureOpen();
    const message = parseJsonRpcMessage({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
    await this.#write(message);
  }

  async receive(message: JsonRpcMessage): Promise<void> {
    this.#ensureOpen();
    const valid = parseJsonRpcMessage(message);
    if (isJsonRpcResponse(valid)) {
      this.#receiveResponse(valid);
      return;
    }
    if (isJsonRpcRequest(valid)) {
      await this.#receiveRequest(valid);
      return;
    }
    if (isJsonRpcNotification(valid)) await this.#receiveNotification(valid);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
    for (const call of this.#pending.values()) call.reject(error);
    this.#pending.clear();
    this.#recentResponses.clear();
    for (const queued of this.#writeQueue.splice(0)) queued.reject(error);
  }
}

export function createJsonRpcConnection(deps: JsonRpcConnectionDeps): JsonRpcConnection {
  return new JsonRpcConnectionImpl(deps);
}
