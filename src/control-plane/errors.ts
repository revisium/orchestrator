export type ControlPlaneErrorCode =
  | 'DAEMON_NOT_RUNNING'
  | 'BOOTSTRAP_NOT_APPLIED'
  | 'ROW_CONFLICT'
  | 'ROW_NOT_FOUND'
  | 'VALIDATION_FAILURE'
  | 'HTTP_ERROR';

export class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: ControlPlaneErrorCode, message: string, options: { status?: number; details?: unknown } = {}) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}
