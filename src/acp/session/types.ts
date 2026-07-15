import type { JsonRpcConnection } from '../jsonrpc/connection.types.js';
import type { JsonRpcValue } from '../jsonrpc/types.js';

export type AcpSessionFailureCode =
  | 'invalid_protocol_version'
  | 'invalid_session_id'
  | 'initialize_already_started'
  | 'session_new_already_started'
  | 'configuration_before_session'
  | 'configuration_already_started'
  | 'prompt_before_session'
  | 'prompt_already_started'
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'malformed_session_update'
  | 'failed'
  | 'closed';

export type AcpSessionDiagnosticCode =
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'malformed_session_update'
  | 'close_failed';

export type AcpSessionDiagnostic = {
  code: AcpSessionDiagnosticCode;
  message: string;
  details?: unknown;
};

export type AcpSessionUpdate = {
  sessionId: string;
  update: JsonRpcValue;
};

export type AcpSessionController = {
  initialize(): Promise<void>;
  create(): Promise<string>;
  configure(): Promise<void>;
  prompt(prompt: JsonRpcValue): Promise<JsonRpcValue>;
  receiveUpdate(params: unknown): Promise<void>;
  close(): Promise<void>;
  getSessionId(): string | null;
};

export type AcpSessionDependencies = {
  connection: JsonRpcConnection;
  configure: (sessionId: string) => Promise<void>;
  onUpdate: (update: AcpSessionUpdate) => Promise<void>;
  onDiagnostic: (diagnostic: AcpSessionDiagnostic) => void;
};
