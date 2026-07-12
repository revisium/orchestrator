import type { JsonRpcProtocolFailureCode } from './types.js';

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
