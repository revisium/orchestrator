import type { JsonRpcConnection } from '../jsonrpc/connection.types.js';
import type {
  AcpCanonicalObject,
  AcpInitializeRequest,
  AcpInitializeResponse,
  AcpNewSessionRequest,
  AcpNewSessionResponse,
  AcpPermissionRequest,
  AcpPromptRequest,
  AcpPromptResponse,
  AcpSessionNotification,
  AcpSetSessionConfigOptionRequest,
  AcpSetSessionConfigOptionResponse,
} from '../protocol/values.js';

export type AcpSessionFailureCode =
  | 'dependencies_not_bound'
  | 'dependencies_already_bound'
  | 'initialize_already_started'
  | 'session_new_already_started'
  | 'configuration_before_session'
  | 'configuration_already_started'
  | 'set_config_option_outside_configuration'
  | 'foreign_session_config_option'
  | 'prompt_before_session'
  | 'prompt_already_started'
  | 'foreign_session_prompt'
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'permission_request_before_session'
  | 'foreign_session_request'
  | 'failed'
  | 'closed';

export type AcpSessionDiagnosticCode =
  | 'unexpected_update'
  | 'foreign_session_update'
  | 'close_failed';

export type AcpSessionDiagnostic = Readonly<{
  code: AcpSessionDiagnosticCode;
  message: string;
  details?: AcpCanonicalObject;
}>;

export type AcpSessionDependencies = Readonly<{
  connection: JsonRpcConnection;
  onUpdate(notification: AcpSessionNotification): Promise<void>;
  onDiagnostic(diagnostic: AcpSessionDiagnostic): void;
}>;

export type AcpSessionController = Readonly<{
  bind(deps: AcpSessionDependencies): void;
  initialize(request: AcpInitializeRequest): Promise<AcpInitializeResponse>;
  create(request: AcpNewSessionRequest): Promise<AcpNewSessionResponse>;
  configure(operation: () => Promise<void>): Promise<void>;
  setConfigOption(request: AcpSetSessionConfigOptionRequest): Promise<AcpSetSessionConfigOptionResponse>;
  prompt(request: AcpPromptRequest): Promise<AcpPromptResponse>;
  receiveUpdate(notification: AcpSessionNotification): Promise<void>;
  assertPermissionRequest(request: AcpPermissionRequest): void;
  close(): Promise<void>;
  getSessionId(): string | null;
}>;
