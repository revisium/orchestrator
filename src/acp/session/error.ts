import type { AcpSessionFailureCode } from './types.js';

export class AcpSessionError extends Error {
  readonly code: AcpSessionFailureCode;

  constructor(code: AcpSessionFailureCode, message: string) {
    super(message);
    this.name = 'AcpSessionError';
    this.code = code;
  }
}
