import type { JsonRpcMessage } from './types.js';

export type JsonRpcFramer = {
  push(chunk: Uint8Array): JsonRpcMessage[];
  finish(): JsonRpcMessage[];
};

export type JsonRpcFramerOptions = {
  maxFrameBytes?: number;
};
