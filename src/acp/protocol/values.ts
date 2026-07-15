import type { JsonRpcValue } from '../jsonrpc/types.js';

export type AcpCanonicalObject = Readonly<Record<string, JsonRpcValue>>;
export type AcpImplementation = Readonly<{ name: string; version: string; title?: string }>;
export type AcpBooleanConfigOptionCapabilities = Readonly<{ _meta?: AcpCanonicalObject | null }>;
export type AcpClientSessionConfigOptionsCapabilities = Readonly<{
  boolean: AcpBooleanConfigOptionCapabilities;
}>;
export type AcpClientSessionCapabilities = Readonly<{
  configOptions: AcpClientSessionConfigOptionsCapabilities;
}>;
export type AcpClientCapabilities = Readonly<{
  fs: Readonly<{ readTextFile: false; writeTextFile: false }>;
  session: AcpClientSessionCapabilities;
  terminal: false;
}>;
export type AcpSessionCloseCapabilities = Readonly<{ _meta?: AcpCanonicalObject | null }>;
export type AcpSessionCapabilities = Readonly<{ close?: AcpSessionCloseCapabilities | null }>;
export type AcpAgentCapabilities = Readonly<{ sessionCapabilities?: AcpSessionCapabilities }>;
export type AcpInitializeRequest = Readonly<{
  protocolVersion: 1;
  clientCapabilities: AcpClientCapabilities;
  clientInfo: AcpImplementation;
}>;
export type AcpInitializeResponse = Readonly<{
  protocolVersion: 1;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo?: AcpImplementation;
}>;
export type AcpNewSessionRequest = Readonly<{ cwd: string; mcpServers: readonly [] }>;

export type AcpSessionConfigSelectOption = Readonly<{
  value: string; name: string; description?: string | null;
}>;
export type AcpSessionConfigSelectGroup = Readonly<{
  group: string; name: string; options: readonly AcpSessionConfigSelectOption[];
}>;
export type AcpSessionConfigSelectOptions =
  | readonly AcpSessionConfigSelectOption[]
  | readonly AcpSessionConfigSelectGroup[];
export type AcpSessionConfigOptionBase = Readonly<{
  id: string; name: string; description?: string | null; category?: string | null;
}>;
export type AcpSessionConfigOptionCategory = NonNullable<AcpSessionConfigOptionBase['category']>;
export type AcpSessionConfigSelectOptionState = AcpSessionConfigOptionBase & Readonly<{
  type: 'select'; currentValue: string; options: AcpSessionConfigSelectOptions;
}>;
export type AcpSessionConfigBooleanOptionState = AcpSessionConfigOptionBase & Readonly<{
  type: 'boolean'; currentValue: boolean;
}>;
export type AcpSessionConfigOption =
  | AcpSessionConfigSelectOptionState
  | AcpSessionConfigBooleanOptionState;
export type AcpNewSessionResponse = Readonly<{
  sessionId: string; configOptions?: readonly AcpSessionConfigOption[] | null;
}>;
export type AcpSetSessionConfigSelectRequest = Readonly<{
  sessionId: string; configId: string; value: string;
}>;
export type AcpSetSessionConfigBooleanRequest = Readonly<{
  sessionId: string; configId: string; type: 'boolean'; value: boolean;
}>;
export type AcpSetSessionConfigOptionRequest =
  | AcpSetSessionConfigSelectRequest
  | AcpSetSessionConfigBooleanRequest;
export type AcpSetSessionConfigOptionResponse = Readonly<{
  configOptions: readonly AcpSessionConfigOption[];
}>;

export type AcpTextContent = Readonly<{ type: 'text'; text: string }>;
export type AcpPromptRequest = Readonly<{
  sessionId: string; prompt: readonly [AcpTextContent];
}>;
export type AcpStopReason =
  | 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
export type AcpPromptResponse = Readonly<{ stopReason: AcpStopReason }>;
export type AcpCloseSessionRequest = Readonly<{ sessionId: string }>;
export type AcpCloseSessionResponse = Readonly<{ _meta?: AcpCanonicalObject | null }>;
export type AcpReportedUsage = Readonly<{ used: number; size: number }>;
export type AcpReportedCost = Readonly<{ amount: number; currency: string }>;

export type AcpPermissionOptionKind =
  | 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
export type AcpPermissionOption = Readonly<{
  optionId: string; name: string; kind: AcpPermissionOptionKind;
}>;
export type AcpPermissionToolCall = AcpCanonicalObject & Readonly<{ toolCallId: string }>;
export type AcpPermissionRequest = Readonly<{
  sessionId: string;
  toolCall: AcpPermissionToolCall;
  options: readonly AcpPermissionOption[];
}>;
export type AcpPermissionResponse = Readonly<{
  outcome:
    | Readonly<{ outcome: 'selected'; optionId: string }>
    | Readonly<{ outcome: 'cancelled' }>;
}>;

export type AcpSessionUpdateDiscriminator =
  | 'user_message_chunk'
  | 'agent_message_chunk'
  | 'agent_thought_chunk'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'available_commands_update'
  | 'current_mode_update'
  | 'config_option_update'
  | 'session_info_update'
  | 'usage_update';
export type AcpSessionActivityDiscriminator =
  Exclude<AcpSessionUpdateDiscriminator, 'usage_update'>;
export type AcpSessionActivitySnapshot = AcpCanonicalObject & Readonly<{
  sessionUpdate: AcpSessionActivityDiscriminator;
}>;
export type AcpSessionUpdate =
  | Readonly<{ kind: 'agent-text'; text: string }>
  | Readonly<{ kind: 'usage'; used: number; size: number; reportedCost?: AcpReportedCost }>
  | Readonly<{
      kind: 'activity';
      activityKind: Exclude<AcpSessionActivityDiscriminator, 'config_option_update'>;
      snapshot: AcpSessionActivitySnapshot;
    }>
  | Readonly<{
      kind: 'activity';
      activityKind: 'config_option_update';
      configOptions: readonly AcpSessionConfigOption[];
      snapshot: AcpSessionActivitySnapshot;
    }>;
export type AcpSessionNotification = Readonly<{
  sessionId: string; update: AcpSessionUpdate;
}>;
