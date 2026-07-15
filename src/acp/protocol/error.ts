export type AcpProtocolFailureCode =
  | 'unsupported_protocol_version'
  | 'invalid_initialize_response'
  | 'invalid_session_new_response'
  | 'invalid_config_option_response'
  | 'invalid_prompt_response'
  | 'invalid_close_response'
  | 'malformed_peer_request'
  | 'malformed_peer_notification'
  | 'unsupported_peer_request'
  | 'unsupported_peer_notification'
  | 'unsupported_session_update';

export class AcpProtocolError extends Error {
  readonly code: AcpProtocolFailureCode;
  readonly method: string;
  readonly details?: unknown;

  constructor(code: AcpProtocolFailureCode, method: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AcpProtocolError';
    this.code = code;
    this.method = method;
    this.details = details;
  }
}
