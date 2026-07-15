import { canonicalizeJsonRpcValue, snapshotJsonRpcRecord } from '../jsonrpc/canonicalizer.js';
import type { JsonRpcParams, JsonRpcRequest, JsonRpcValue } from '../jsonrpc/types.js';
import { AcpProtocolError, type AcpProtocolFailureCode } from './error.js';
import { ACP_METHODS } from './methods.js';
import type {
  AcpAgentCapabilities,
  AcpCanonicalObject,
  AcpCloseSessionResponse,
  AcpImplementation,
  AcpInitializeResponse,
  AcpNewSessionResponse,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpPermissionToolCall,
  AcpPromptResponse,
  AcpReportedCost,
  AcpSessionCapabilities,
  AcpSessionActivitySnapshot,
  AcpSessionConfigBooleanOptionState,
  AcpSessionConfigOption,
  AcpSessionConfigOptionBase,
  AcpSessionConfigSelectGroup,
  AcpSessionConfigSelectOption,
  AcpSessionConfigSelectOptionState,
  AcpSessionNotification,
  AcpSessionUpdate,
  AcpSessionUpdateDiscriminator,
  AcpSetSessionConfigOptionResponse,
  AcpStopReason,
} from './values.js';

function fail(
  code: AcpProtocolFailureCode,
  method: string,
  message: string,
  details?: unknown,
): never {
  throw new AcpProtocolError(code, method, message, details);
}

function own(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function recordFor(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): Record<string, unknown> {
  let record: Record<string, unknown> | undefined;
  try {
    record = snapshotJsonRpcRecord(value);
  } catch {
    fail(code, method, 'ACP value cannot be inspected safely');
  }
  if (!record) fail(code, method, 'ACP value must be a canonical object');
  return record;
}

function nonEmptyString(
  record: Record<string, unknown>,
  key: string,
  code: AcpProtocolFailureCode,
  method: string,
): string {
  const field = record[key];
  if (!own(record, key) || typeof field !== 'string' || field.length === 0) {
    fail(code, method, `ACP ${key} must be a nonempty string`, field);
  }
  return field;
}

function parseImplementation(value: unknown, code: AcpProtocolFailureCode): AcpImplementation {
  const implementation = recordFor(value, code, ACP_METHODS.initialize);
  const name = nonEmptyString(implementation, 'name', code, ACP_METHODS.initialize);
  const version = nonEmptyString(implementation, 'version', code, ACP_METHODS.initialize);
  const title = implementation['title'];
  if (own(implementation, 'title') && title !== null && typeof title !== 'string') {
    fail(code, ACP_METHODS.initialize, 'ACP implementation title must be string or null', title);
  }
  return { name, version, ...(typeof title === 'string' ? { title } : {}) };
}

function canonicalObject(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): AcpCanonicalObject {
  let canonical: JsonRpcValue | undefined;
  try {
    canonical = canonicalizeJsonRpcValue(value);
  } catch {
    fail(code, method, 'ACP value cannot be canonicalized safely');
  }
  if (canonical === undefined || canonical === null || Array.isArray(canonical) ||
      typeof canonical !== 'object') {
    fail(code, method, 'ACP value must be a canonical object');
  }
  return canonical;
}

function parseOptionalMeta(
  record: Record<string, unknown>,
  code: AcpProtocolFailureCode,
  method: string,
): Readonly<{ _meta?: AcpCanonicalObject | null }> {
  if (!own(record, '_meta')) return {};
  const rawMeta = record['_meta'];
  return rawMeta === null
    ? { _meta: null }
    : { _meta: canonicalObject(rawMeta, code, method) };
}

function parseAgentCapabilities(value: unknown): AcpAgentCapabilities {
  const capabilities = recordFor(value, 'invalid_initialize_response', ACP_METHODS.initialize);
  if (!own(capabilities, 'sessionCapabilities')) return {};
  const sessionRecord = recordFor(
    capabilities['sessionCapabilities'],
    'invalid_initialize_response',
    ACP_METHODS.initialize,
  );
  let sessionCapabilities: AcpSessionCapabilities;
  if (!own(sessionRecord, 'close')) {
    sessionCapabilities = {};
  } else if (sessionRecord['close'] === null) {
    sessionCapabilities = { close: null };
  } else {
    const closeRecord = recordFor(
      sessionRecord['close'],
      'invalid_initialize_response',
      ACP_METHODS.initialize,
    );
    sessionCapabilities = {
      close: parseOptionalMeta(
        closeRecord,
        'invalid_initialize_response',
        ACP_METHODS.initialize,
      ),
    };
  }
  return { sessionCapabilities };
}

function optionalNullableString(
  record: Record<string, unknown>,
  key: string,
  code: AcpProtocolFailureCode,
  method: string,
): string | null | undefined {
  if (!own(record, key)) return undefined;
  const field = record[key];
  if (field !== null && typeof field !== 'string') {
    fail(code, method, `ACP ${key} must be string or null`, field);
  }
  return field;
}

function parseConfigBase(
  record: Record<string, unknown>,
  code: AcpProtocolFailureCode,
  method: string,
): AcpSessionConfigOptionBase {
  const id = nonEmptyString(record, 'id', code, method);
  const name = nonEmptyString(record, 'name', code, method);
  const description = optionalNullableString(record, 'description', code, method);
  const category = optionalNullableString(record, 'category', code, method);
  return {
    id,
    name,
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
  };
}

function parseSelectOption(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): AcpSessionConfigSelectOption {
  const option = recordFor(value, code, method);
  const description = optionalNullableString(option, 'description', code, method);
  return {
    value: nonEmptyString(option, 'value', code, method),
    name: nonEmptyString(option, 'name', code, method),
    ...(description === undefined ? {} : { description }),
  };
}

function parseSelectGroup(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): AcpSessionConfigSelectGroup {
  const group = recordFor(value, code, method);
  const rawOptions = group['options'];
  if (!own(group, 'options') || !Array.isArray(rawOptions)) {
    fail(code, method, 'ACP select group options must be an array', rawOptions);
  }
  return {
    group: nonEmptyString(group, 'group', code, method),
    name: nonEmptyString(group, 'name', code, method),
    options: rawOptions.map((option) => parseSelectOption(option, code, method)),
  };
}

function parseSelectOptions(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): readonly AcpSessionConfigSelectOption[] | readonly AcpSessionConfigSelectGroup[] {
  if (!Array.isArray(value)) fail(code, method, 'ACP select options must be an array', value);
  if (value.length === 0) return [];
  const first = recordFor(value[0], code, method);
  const grouped = own(first, 'group');
  for (const candidate of value) {
    const candidateRecord = recordFor(candidate, code, method);
    if (own(candidateRecord, 'group') !== grouped) {
      fail(code, method, 'ACP select options cannot mix grouped and flat values', value);
    }
  }
  return grouped
    ? value.map((group) => parseSelectGroup(group, code, method))
    : value.map((option) => parseSelectOption(option, code, method));
}

function parseSessionConfigOption(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): AcpSessionConfigOption {
  const option = recordFor(value, code, method);
  const base = parseConfigBase(option, code, method);
  if (option['type'] === 'boolean') {
    if (!own(option, 'currentValue') || typeof option['currentValue'] !== 'boolean') {
      fail(code, method, 'ACP boolean config currentValue must be boolean', option['currentValue']);
    }
    const parsed: AcpSessionConfigBooleanOptionState = {
      ...base,
      type: 'boolean',
      currentValue: option['currentValue'],
    };
    return parsed;
  }
  if (option['type'] !== 'select' || typeof option['currentValue'] !== 'string' ||
      !own(option, 'options')) {
    fail(code, method, 'ACP select config shape is invalid', option);
  }
  const parsed: AcpSessionConfigSelectOptionState = {
    ...base,
    type: 'select',
    currentValue: option['currentValue'],
    options: parseSelectOptions(option['options'], code, method),
  };
  return parsed;
}

function parseSessionConfigOptions(
  value: unknown,
  code: AcpProtocolFailureCode,
  method: string,
): readonly AcpSessionConfigOption[] {
  if (!Array.isArray(value)) fail(code, method, 'ACP configOptions must be an array', value);
  return value.map((option) => parseSessionConfigOption(option, code, method));
}

export function parseAcpInitializeResponse(value: JsonRpcValue): AcpInitializeResponse {
  const response = recordFor(value, 'invalid_initialize_response', ACP_METHODS.initialize);
  if (response['protocolVersion'] !== 1) {
    const code = typeof response['protocolVersion'] === 'number'
      ? 'unsupported_protocol_version'
      : 'invalid_initialize_response';
    fail(code, ACP_METHODS.initialize, 'ACP protocol version must be 1', response['protocolVersion']);
  }
  const agentInfoValue = response['agentInfo'];
  const agentInfo = !own(response, 'agentInfo') || agentInfoValue === null
    ? undefined
    : parseImplementation(agentInfoValue, 'invalid_initialize_response');
  const agentCapabilities = own(response, 'agentCapabilities')
    ? parseAgentCapabilities(response['agentCapabilities'])
    : undefined;
  return {
    protocolVersion: 1,
    ...(agentCapabilities === undefined ? {} : { agentCapabilities }),
    ...(agentInfo === undefined ? {} : { agentInfo }),
  };
}

export function parseAcpSessionNewResponse(value: JsonRpcValue): AcpNewSessionResponse {
  const response = recordFor(value, 'invalid_session_new_response', ACP_METHODS.newSession);
  const sessionId = nonEmptyString(
    response,
    'sessionId',
    'invalid_session_new_response',
    ACP_METHODS.newSession,
  );
  if (!own(response, 'configOptions')) return { sessionId };
  if (response['configOptions'] === null) return { sessionId, configOptions: null };
  return {
    sessionId,
    configOptions: parseSessionConfigOptions(
      response['configOptions'],
      'invalid_session_new_response',
      ACP_METHODS.newSession,
    ),
  };
}

export function parseAcpSetSessionConfigOptionResponse(
  value: JsonRpcValue,
): AcpSetSessionConfigOptionResponse {
  const response = recordFor(
    value,
    'invalid_config_option_response',
    ACP_METHODS.setSessionConfigOption,
  );
  if (!own(response, 'configOptions')) {
    fail(
      'invalid_config_option_response',
      ACP_METHODS.setSessionConfigOption,
      'ACP set-config response requires configOptions',
    );
  }
  return {
    configOptions: parseSessionConfigOptions(
      response['configOptions'],
      'invalid_config_option_response',
      ACP_METHODS.setSessionConfigOption,
    ),
  };
}

function isStopReason(value: unknown): value is AcpStopReason {
  return value === 'end_turn' || value === 'max_tokens' ||
    value === 'max_turn_requests' || value === 'refusal' || value === 'cancelled';
}

export function parseAcpPromptResponse(value: JsonRpcValue): AcpPromptResponse {
  const response = recordFor(value, 'invalid_prompt_response', ACP_METHODS.prompt);
  if (!own(response, 'stopReason') || !isStopReason(response['stopReason'])) {
    fail('invalid_prompt_response', ACP_METHODS.prompt, 'ACP prompt stopReason is invalid');
  }
  return { stopReason: response['stopReason'] };
}

export function parseAcpCloseSessionResponse(value: JsonRpcValue): AcpCloseSessionResponse {
  const response = recordFor(value, 'invalid_close_response', ACP_METHODS.closeSession);
  return parseOptionalMeta(response, 'invalid_close_response', ACP_METHODS.closeSession);
}

function isPermissionKind(value: unknown): value is AcpPermissionOption['kind'] {
  return value === 'allow_once' || value === 'allow_always' ||
    value === 'reject_once' || value === 'reject_always';
}

function parsePermissionOption(value: unknown): AcpPermissionOption {
  const option = recordFor(value, 'malformed_peer_request', ACP_METHODS.requestPermission);
  const kind = option['kind'];
  if (!own(option, 'kind') || !isPermissionKind(kind)) {
    fail(
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
      'ACP permission option kind is invalid',
      kind,
    );
  }
  return {
    optionId: nonEmptyString(
      option,
      'optionId',
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
    ),
    name: nonEmptyString(
      option,
      'name',
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
    ),
    kind,
  };
}

function parsePermissionRequestParams(params: JsonRpcParams): AcpPermissionRequest {
  const request = recordFor(params, 'malformed_peer_request', ACP_METHODS.requestPermission);
  const sessionId = nonEmptyString(
    request,
    'sessionId',
    'malformed_peer_request',
    ACP_METHODS.requestPermission,
  );
  if (!own(request, 'toolCall')) {
    fail(
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
      'ACP permission request requires toolCall',
    );
  }
  const toolCallSnapshot = canonicalObject(
    request['toolCall'],
    'malformed_peer_request',
    ACP_METHODS.requestPermission,
  );
  const toolCallId = typeof toolCallSnapshot['toolCallId'] === 'string'
    ? toolCallSnapshot['toolCallId']
    : '';
  if (toolCallId.length === 0) {
    fail(
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
      'ACP permission toolCallId must be nonempty',
    );
  }
  const toolCall: AcpPermissionToolCall = { ...toolCallSnapshot, toolCallId };
  const rawOptions = request['options'];
  if (!own(request, 'options') || !Array.isArray(rawOptions)) {
    fail(
      'malformed_peer_request',
      ACP_METHODS.requestPermission,
      'ACP permission options must be an array',
      rawOptions,
    );
  }
  return {
    sessionId,
    toolCall,
    options: rawOptions.map(parsePermissionOption),
  };
}

export function parseAcpPeerRequest(request: JsonRpcRequest): AcpPermissionRequest {
  if (request.method !== ACP_METHODS.requestPermission) {
    fail('unsupported_peer_request', request.method, 'Unsupported ACP peer request method');
  }
  const params = request.params;
  if (!Object.hasOwn(request, 'params') || params === undefined) {
    fail('malformed_peer_request', request.method, 'ACP permission request params are required');
  }
  return parsePermissionRequestParams(params);
}

export function parseAcpPeerNotification(notification: Readonly<{
  method: string;
  params?: JsonRpcParams;
}>): AcpSessionNotification {
  const { method } = notification;
  if (method !== ACP_METHODS.sessionUpdate) {
    fail('unsupported_peer_notification', method, 'Unsupported ACP peer notification method');
  }
  const params = notification.params;
  if (!Object.hasOwn(notification, 'params') || params === undefined) {
    fail('malformed_peer_notification', method, 'ACP session update params are required');
  }
  return parseSessionUpdateParams(params);
}

function malformedNotification(message: string, details?: unknown): never {
  fail('malformed_peer_notification', ACP_METHODS.sessionUpdate, message, details);
}

function requireCanonicalArray(value: unknown, field: string): readonly AcpCanonicalObject[] {
  if (!Array.isArray(value)) malformedNotification(`ACP ${field} must be an array`, value);
  return value.map((entry) => canonicalObject(
    entry,
    'malformed_peer_notification',
    ACP_METHODS.sessionUpdate,
  ));
}

function requireContent(update: AcpCanonicalObject): AcpCanonicalObject {
  if (!Object.hasOwn(update, 'content')) {
    malformedNotification('ACP update content is required');
  }
  return canonicalObject(
    update['content'],
    'malformed_peer_notification',
    ACP_METHODS.sessionUpdate,
  );
}

function validateNonTextContent(content: AcpCanonicalObject): void {
  const type = content['type'];
  if (type === 'image' || type === 'audio') {
    if (typeof content['data'] !== 'string' || typeof content['mimeType'] !== 'string') {
      malformedNotification(`ACP ${type} content requires data and mimeType`, content);
    }
    return;
  }
  if (type === 'resource_link') {
    if (typeof content['uri'] !== 'string' || typeof content['name'] !== 'string') {
      malformedNotification('ACP resource_link requires uri and name', content);
    }
    return;
  }
  if (type === 'resource') {
    const resource = canonicalObject(
      content['resource'],
      'malformed_peer_notification',
      ACP_METHODS.sessionUpdate,
    );
    if (typeof resource['uri'] !== 'string') {
      malformedNotification('ACP embedded resource requires uri', resource);
    }
    return;
  }
  malformedNotification('ACP agent message content type is unsupported', type);
}

function parseUsageUpdate(update: AcpCanonicalObject): AcpSessionUpdate {
  const used = update['used'];
  const size = update['size'];
  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 ||
      typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    malformedNotification('ACP usage counters must be nonnegative safe integers', update);
  }
  let reportedCost: AcpReportedCost | undefined;
  if (Object.hasOwn(update, 'cost')) {
    const cost = canonicalObject(
      update['cost'],
      'malformed_peer_notification',
      ACP_METHODS.sessionUpdate,
    );
    const amount = cost['amount'];
    const currency = cost['currency'];
    if (typeof amount !== 'number' || !Number.isFinite(amount) ||
        typeof currency !== 'string' || currency.length === 0) {
      malformedNotification('ACP reported cost is invalid', cost);
    }
    reportedCost = { amount, currency };
  }
  return {
    kind: 'usage',
    used,
    size,
    ...(reportedCost === undefined ? {} : { reportedCost }),
  };
}

function validateActivity(
  discriminator: Exclude<
    AcpSessionUpdateDiscriminator,
    'agent_message_chunk' | 'config_option_update' | 'usage_update'
  >,
  update: AcpCanonicalObject,
): void {
  switch (discriminator) {
    case 'user_message_chunk':
    case 'agent_thought_chunk':
      requireContent(update);
      return;
    case 'tool_call':
      if (typeof update['toolCallId'] !== 'string' || update['toolCallId'].length === 0 ||
          typeof update['title'] !== 'string') {
        malformedNotification('ACP tool_call requires toolCallId and title', update);
      }
      return;
    case 'tool_call_update':
      if (typeof update['toolCallId'] !== 'string' || update['toolCallId'].length === 0) {
        malformedNotification('ACP tool_call_update requires toolCallId', update);
      }
      return;
    case 'plan':
      requireCanonicalArray(update['entries'], 'plan.entries');
      return;
    case 'available_commands_update':
      requireCanonicalArray(update['availableCommands'], 'availableCommands');
      return;
    case 'current_mode_update':
      if (typeof update['currentModeId'] !== 'string' || update['currentModeId'].length === 0) {
        malformedNotification('ACP current mode requires currentModeId', update);
      }
      return;
    case 'session_info_update':
      optionalNullableString(
        update,
        'title',
        'malformed_peer_notification',
        ACP_METHODS.sessionUpdate,
      );
      optionalNullableString(
        update,
        'updatedAt',
        'malformed_peer_notification',
        ACP_METHODS.sessionUpdate,
      );
  }
}

function parseSessionUpdateParams(params: JsonRpcParams): AcpSessionNotification {
  const notification = recordFor(
    params,
    'malformed_peer_notification',
    ACP_METHODS.sessionUpdate,
  );
  const sessionId = nonEmptyString(
    notification,
    'sessionId',
    'malformed_peer_notification',
    ACP_METHODS.sessionUpdate,
  );
  if (!own(notification, 'update')) malformedNotification('ACP session update is required');
  const update = canonicalObject(
    notification['update'],
    'malformed_peer_notification',
    ACP_METHODS.sessionUpdate,
  );
  const discriminator = update['sessionUpdate'];
  if (typeof discriminator !== 'string') {
    malformedNotification('ACP sessionUpdate discriminator must be a string', discriminator);
  }
  if (discriminator === 'agent_message_chunk') {
    const content = requireContent(update);
    if (content['type'] === 'text') {
      if (typeof content['text'] !== 'string') {
        malformedNotification('ACP text content requires text', content);
      }
      return { sessionId, update: { kind: 'agent-text', text: content['text'] } };
    }
    validateNonTextContent(content);
    const snapshot: AcpSessionActivitySnapshot = { ...update, sessionUpdate: discriminator };
    return {
      sessionId,
      update: {
        kind: 'activity',
        activityKind: 'agent_message_chunk',
        snapshot,
      },
    };
  }
  if (discriminator === 'usage_update') {
    return { sessionId, update: parseUsageUpdate(update) };
  }
  if (discriminator === 'config_option_update') {
    const snapshot: AcpSessionActivitySnapshot = { ...update, sessionUpdate: discriminator };
    return {
      sessionId,
      update: {
        kind: 'activity',
        activityKind: 'config_option_update',
        configOptions: parseSessionConfigOptions(
          update['configOptions'],
          'malformed_peer_notification',
          ACP_METHODS.sessionUpdate,
        ),
        snapshot,
      },
    };
  }
  const activityDiscriminators = [
    'user_message_chunk',
    'agent_thought_chunk',
    'tool_call',
    'tool_call_update',
    'plan',
    'available_commands_update',
    'current_mode_update',
    'session_info_update',
  ] as const;
  const activityKind = activityDiscriminators.find((candidate) => candidate === discriminator);
  if (!activityKind) {
    fail(
      'unsupported_session_update',
      ACP_METHODS.sessionUpdate,
      'Unsupported ACP session update',
      discriminator,
    );
  }
  validateActivity(activityKind, update);
  const snapshot = { ...update, sessionUpdate: activityKind };
  return {
    sessionId,
    update: { kind: 'activity', activityKind, snapshot },
  };
}
