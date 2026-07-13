import type {
  JsonRpcErrorObject,
  JsonRpcMessage,
  JsonRpcParams,
  JsonRpcRequest,
  JsonRpcValue,
} from './types.js';

export type JsonRpcServerRequestOutcome =
  | { kind: 'result'; value: JsonRpcValue }
  | { kind: 'error'; error: JsonRpcErrorObject };

export type AcpTransportWrite = (chunk: Uint8Array) => Promise<void>;

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
