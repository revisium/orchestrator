import type { JsonRpcConnection, JsonRpcServerRequestOutcome } from '../jsonrpc/connection.types.js';
import type { JsonRpcParams, JsonRpcRequest } from '../jsonrpc/types.js';
import type { AcpPermissionRequestHandler, AcpPermissionResolver } from '../prompt-execution/permission-request-handler.js';
import type { AcpPromptOutcomeCollector } from '../prompt-execution/prompt-outcome-collector.js';
import type { AcpSessionNotification, AcpImplementation } from '../protocol/values.js';
import type { AcpSession } from '../session/session.js';
import type { AcpConnector } from './connector.js';

export type AcpInboundNotification = Readonly<{ method: string; params?: JsonRpcParams }>;
export type AcpInboundHandlers = Readonly<{
  onRequest(request: JsonRpcRequest): Promise<JsonRpcServerRequestOutcome>;
  onNotification(notification: AcpInboundNotification): Promise<void>;
}>;
export type AcpOpenConnection = (handlers: AcpInboundHandlers) => Promise<AcpOpenedConnection>;
export type AcpOpenedConnection = Readonly<{
  connection: JsonRpcConnection;
  inboundFailure: Promise<Error>;
  start(): void;
  completionBarrier(): Promise<void>;
}>;
export type AcpInvocationRequest = Readonly<{
  cwd: string;
  prompt: string;
  clientInfo: AcpImplementation;
}>;
export type AcpDiagnosticScalar = string | number | boolean | null;
export type AcpDiagnosticDetails =
  | AcpDiagnosticScalar
  | readonly AcpDiagnosticDetails[]
  | Readonly<{ [key: string]: AcpDiagnosticDetails }>;
export type AcpInvocationFailureCode =
  | 'permission_request_after_terminal'
  | 'session_update_after_terminal'
  | 'terminal_outcome_unavailable';
export type AcpInvocationProtocolDiagnosticCode =
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
export type AcpInvocationSessionDiagnosticCode =
  | 'dependencies_not_bound' | 'dependencies_already_bound' | 'initialize_already_started'
  | 'session_new_already_started' | 'configuration_before_session' | 'configuration_already_started'
  | 'set_config_option_outside_configuration' | 'foreign_session_config_option'
  | 'prompt_before_session' | 'prompt_already_started' | 'foreign_session_prompt'
  | 'unexpected_update' | 'foreign_session_update' | 'permission_request_before_session'
  | 'foreign_session_request' | 'failed' | 'closed' | 'close_failed';
export type AcpInvocationRuntimeDiagnosticCode =
  | 'session_update_observer_failed'
  | 'connection_failed_after_terminal';
export type AcpInvocationDiagnostic =
  | Readonly<{ source: 'protocol'; code: AcpInvocationProtocolDiagnosticCode; message: string; details?: AcpDiagnosticDetails }>
  | Readonly<{ source: 'session'; code: AcpInvocationSessionDiagnosticCode; message: string; details?: AcpDiagnosticDetails }>
  | Readonly<{ source: 'prompt-execution'; code: 'prompt_execution_diagnostic'; message: string; details?: AcpDiagnosticDetails }>
  | Readonly<{ source: 'runtime'; code: AcpInvocationRuntimeDiagnosticCode; message: string; details?: AcpDiagnosticDetails }>;
export type AcpInvocationDependencies = Readonly<{
  openConnection: AcpOpenConnection;
  connector: AcpConnector;
  resolvePermission: AcpPermissionResolver;
  onSessionUpdate?: (notification: AcpSessionNotification) => void;
  onDiagnostic(diagnostic: AcpInvocationDiagnostic): void;
}>;
export type AcpInvocationComponents = Readonly<{
  session: AcpSession;
  permissionHandler: AcpPermissionRequestHandler;
  outcomeCollector: AcpPromptOutcomeCollector;
}>;
