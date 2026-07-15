import { JsonRpcProtocolError } from './errors.js';
import {
  createJsonRpcRequest,
  encodeJsonRpcMessage,
  isJsonRpcMethodMessage,
  isJsonRpcRequestMessage,
  isJsonRpcSuccessResponse,
} from './connection.helpers.js';
import { parseJsonRpcMessage } from './parser.js';
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
  JsonRpcValue,
} from './types.js';
import type {
  JsonRpcConnection,
  JsonRpcConnectionDeps,
  JsonRpcServerRequestOutcome,
} from './connection.types.js';

type PendingJsonRpcRequest = {
  resolve(value: JsonRpcValue): void;
  reject(error: unknown): void;
};

type QueuedTransportWrite = {
  chunk: Uint8Array;
  resolve(): void;
  reject(error: unknown): void;
};

export class AcpJsonRpcConnection implements JsonRpcConnection {
  private deps: JsonRpcConnectionDeps | undefined;
  private readonly pendingRequests = new Map<JsonRpcId, PendingJsonRpcRequest>();
  private readonly completedResponseIds = new Set<JsonRpcId>();
  private readonly writeQueue: QueuedTransportWrite[] = [];
  private nextRequestId = 1;
  private closed = false;
  private writeInProgress = false;

  bindDependencies(deps: JsonRpcConnectionDeps): void {
    if (this.deps) throw new Error('ACP JSON-RPC connection is already bound');
    this.deps = deps;
  }

  private getDependencies(): JsonRpcConnectionDeps {
    if (!this.deps) throw new Error('ACP JSON-RPC connection is not bound');
    return this.deps;
  }

  private assertConnectionOpen(): void {
    if (this.closed) throw new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
  }

  private processWriteQueue(): void {
    if (this.writeInProgress) return;
    const queued = this.writeQueue.shift();
    if (!queued) return;
    if (this.closed) {
      queued.reject(new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed'));
      this.processWriteQueue();
      return;
    }
    this.writeInProgress = true;
    void this.sendQueuedWrite(queued);
  }

  private async sendQueuedWrite(queued: QueuedTransportWrite): Promise<void> {
    try {
      await this.getDependencies().write(queued.chunk);
      queued.resolve();
    } catch (error) {
      queued.reject(new JsonRpcProtocolError('send_failed', 'JSON-RPC transport write failed', error));
    } finally {
      this.writeInProgress = false;
      this.processWriteQueue();
    }
  }

  private enqueueTransportWrite(chunk: Uint8Array): Promise<void> {
    this.assertConnectionOpen();
    const operation = new Promise<void>((resolve, reject) => {
      this.writeQueue.push({ chunk, resolve, reject });
    });
    this.processWriteQueue();
    return operation;
  }

  private rememberCompletedResponseId(id: JsonRpcId): void {
    this.completedResponseIds.add(id);
    if (this.completedResponseIds.size <= 1_024) return;
    const oldest = this.completedResponseIds.values().next().value as JsonRpcId;
    this.completedResponseIds.delete(oldest);
  }

  private handleResponseMessage(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    if (message.id === null) {
      throw new JsonRpcProtocolError('uncorrelated_null_response', 'Null JSON-RPC response id cannot be correlated');
    }
    const call = this.pendingRequests.get(message.id);
    if (!call) {
      const code = this.completedResponseIds.has(message.id) ? 'duplicate_response_id' : 'unknown_response_id';
      throw new JsonRpcProtocolError(code, `Unexpected JSON-RPC response id ${String(message.id)}`);
    }
    this.pendingRequests.delete(message.id);
    this.rememberCompletedResponseId(message.id);
    if (isJsonRpcSuccessResponse(message)) {
      call.resolve(message.result);
      return;
    }
    call.reject(new JsonRpcProtocolError('remote_error', message.error.message, message.error));
  }

  private async handleIncomingRequestMessage(message: JsonRpcRequest): Promise<void> {
    let chunk: Uint8Array;
    try {
      const deps = this.getDependencies();
      const outcome: JsonRpcServerRequestOutcome = deps.onRequest
        ? await deps.onRequest({
          jsonrpc: message.jsonrpc,
          method: message.method,
          params: Object.hasOwn(message, 'params') ? message.params : undefined,
          id: message.id,
        })
        : { kind: 'error', error: { code: -32601, message: 'Method not found' } };
      const response = outcome.kind === 'result'
        ? parseJsonRpcMessage({ jsonrpc: '2.0', id: message.id, result: outcome.value })
        : parseJsonRpcMessage({ jsonrpc: '2.0', id: message.id, error: outcome.error });
      chunk = encodeJsonRpcMessage(response);
    } catch {
      chunk = encodeJsonRpcMessage(parseJsonRpcMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'Internal error' },
      }));
    }
    await this.enqueueTransportWrite(chunk);
  }

  private async handleIncomingNotificationMessage(message: Extract<JsonRpcMessage, { method: string }>): Promise<void> {
    const deps = this.getDependencies();
    if (!deps.onNotification) return;
    try {
      await deps.onNotification({
        method: message.method,
        params: Object.hasOwn(message, 'params') ? message.params : undefined,
      });
    } catch (error) {
      throw new JsonRpcProtocolError('handler_failed', 'JSON-RPC notification handler failed', error);
    }
  }

  request(method: string, params?: JsonRpcParams): Promise<JsonRpcValue> {
    this.assertConnectionOpen();
    if (!Number.isSafeInteger(this.nextRequestId)) {
      throw new JsonRpcProtocolError('request_id_exhausted', 'JSON-RPC request id space is exhausted');
    }
    const id = this.nextRequestId;
    const message = createJsonRpcRequest(method, params, id);
    const chunk = encodeJsonRpcMessage(message);
    this.nextRequestId += 1;
    const result = new Promise<JsonRpcValue>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });
    void this.enqueueTransportWrite(chunk).catch((error: unknown) => {
      const call = this.pendingRequests.get(id);
      if (call) {
        this.pendingRequests.delete(id);
        call.reject(error);
      }
    });
    return result;
  }

  async notify(method: string, params?: JsonRpcParams): Promise<void> {
    this.assertConnectionOpen();
    const message = parseJsonRpcMessage({
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    });
    await this.enqueueTransportWrite(encodeJsonRpcMessage(message));
  }

  async receive(message: JsonRpcMessage): Promise<void> {
    this.assertConnectionOpen();
    const valid = parseJsonRpcMessage(message);
    if (!isJsonRpcMethodMessage(valid)) {
      this.handleResponseMessage(valid);
      return;
    }
    if (isJsonRpcRequestMessage(valid)) {
      await this.handleIncomingRequestMessage(valid);
      return;
    }
    await this.handleIncomingNotificationMessage(valid);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new JsonRpcProtocolError('closed', 'JSON-RPC connection is closed');
    for (const call of this.pendingRequests.values()) call.reject(error);
    this.pendingRequests.clear();
    this.completedResponseIds.clear();
    for (const queued of this.writeQueue.splice(0)) queued.reject(error);
  }
}

export function createJsonRpcConnection(deps: JsonRpcConnectionDeps): JsonRpcConnection {
  const connection = new AcpJsonRpcConnection();
  connection.bindDependencies(deps);
  return connection;
}
