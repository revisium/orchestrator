import type { AcpSessionFailureCode } from './types.js';

export class AcpSessionError extends Error {
  readonly code: AcpSessionFailureCode;
  readonly details?: unknown;

  constructor(code: AcpSessionFailureCode, message = code, details?: unknown) {
    super(message);
    this.name = 'AcpSessionError';
    this.code = code;
    this.details = details;
  }
}
