export type JsonRpcProtocolFailureCode =
  | 'overflow'
  | 'invalid_utf8'
  | 'invalid_json'
  | 'invalid_message'
  | 'unknown_response_id'
  | 'duplicate_response_id'
  | 'uncorrelated_null_response'
  | 'request_id_exhausted'
  | 'remote_error'
  | 'send_failed'
  | 'handler_failed'
  | 'closed';

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
