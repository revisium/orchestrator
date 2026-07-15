import type { JsonRpcValue } from '../../jsonrpc/types.js';
import type { AcpProtocolFailureCode } from '../error.js';
import { ACP_METHODS } from '../methods.js';
import type {
  AcpAgentCapabilities, AcpCanonicalObject, AcpCloseSessionResponse, AcpImplementation,
  AcpInitializeResponse, AcpNewSessionResponse, AcpPromptResponse, AcpSessionCapabilities,
  AcpSessionConfigBooleanOptionState, AcpSessionConfigOption, AcpSessionConfigOptionBase,
  AcpSessionConfigSelectGroup, AcpSessionConfigSelectOption, AcpSessionConfigSelectOptionState,
  AcpSetSessionConfigOptionResponse, AcpStopReason,
} from '../values.js';
import { canonicalObject, fail, nonEmptyString, optionalNullableString, own, recordFor } from './value-readers.js';

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

function parseOptionalMeta(record: Record<string, unknown>, code: AcpProtocolFailureCode, method: string): Readonly<{ _meta?: AcpCanonicalObject | null }> {
  if (!own(record, '_meta')) return {};
  const rawMeta = record['_meta'];
  return rawMeta === null ? { _meta: null } : { _meta: canonicalObject(rawMeta, code, method) };
}

function parseAgentCapabilities(value: unknown): AcpAgentCapabilities {
  const capabilities = recordFor(value, 'invalid_initialize_response', ACP_METHODS.initialize);
  if (!own(capabilities, 'sessionCapabilities')) return {};
  const sessionRecord = recordFor(capabilities['sessionCapabilities'], 'invalid_initialize_response', ACP_METHODS.initialize);
  let sessionCapabilities: AcpSessionCapabilities;
  if (!own(sessionRecord, 'close')) {
    sessionCapabilities = {};
  } else if (sessionRecord['close'] === null) {
    sessionCapabilities = { close: null };
  } else {
    const closeRecord = recordFor(sessionRecord['close'], 'invalid_initialize_response', ACP_METHODS.initialize);
    sessionCapabilities = { close: parseOptionalMeta(closeRecord, 'invalid_initialize_response', ACP_METHODS.initialize) };
  }
  return { sessionCapabilities };
}

function parseConfigBase(record: Record<string, unknown>, code: AcpProtocolFailureCode, method: string): AcpSessionConfigOptionBase {
  const id = nonEmptyString(record, 'id', code, method);
  const name = nonEmptyString(record, 'name', code, method);
  const description = optionalNullableString(record, 'description', code, method);
  const category = optionalNullableString(record, 'category', code, method);
  return { id, name, ...(description === undefined ? {} : { description }), ...(category === undefined ? {} : { category }) };
}

function parseSelectOption(value: unknown, code: AcpProtocolFailureCode, method: string): AcpSessionConfigSelectOption {
  const option = recordFor(value, code, method);
  const description = optionalNullableString(option, 'description', code, method);
  return { value: nonEmptyString(option, 'value', code, method), name: nonEmptyString(option, 'name', code, method), ...(description === undefined ? {} : { description }) };
}

function parseSelectGroup(value: unknown, code: AcpProtocolFailureCode, method: string): AcpSessionConfigSelectGroup {
  const group = recordFor(value, code, method);
  const rawOptions = group['options'];
  if (!own(group, 'options') || !Array.isArray(rawOptions)) {
    fail(code, method, 'ACP select group options must be an array', rawOptions);
  }
  return { group: nonEmptyString(group, 'group', code, method), name: nonEmptyString(group, 'name', code, method), options: rawOptions.map((option) => parseSelectOption(option, code, method)) };
}

function parseSelectOptions(value: unknown, code: AcpProtocolFailureCode, method: string): readonly AcpSessionConfigSelectOption[] | readonly AcpSessionConfigSelectGroup[] {
  if (!Array.isArray(value)) fail(code, method, 'ACP select options must be an array', value);
  if (value.length === 0) return [];
  const grouped = own(recordFor(value[0], code, method), 'group');
  for (const candidate of value) {
    if (own(recordFor(candidate, code, method), 'group') !== grouped) {
      fail(code, method, 'ACP select options cannot mix grouped and flat values', value);
    }
  }
  return grouped ? value.map((group) => parseSelectGroup(group, code, method)) : value.map((option) => parseSelectOption(option, code, method));
}

function parseSessionConfigOption(value: unknown, code: AcpProtocolFailureCode, method: string): AcpSessionConfigOption {
  const option = recordFor(value, code, method);
  const base = parseConfigBase(option, code, method);
  if (option['type'] === 'boolean') {
    if (!own(option, 'currentValue') || typeof option['currentValue'] !== 'boolean') {
      fail(code, method, 'ACP boolean config currentValue must be boolean', option['currentValue']);
    }
    const parsed: AcpSessionConfigBooleanOptionState = { ...base, type: 'boolean', currentValue: option['currentValue'] };
    return parsed;
  }
  if (option['type'] !== 'select' || typeof option['currentValue'] !== 'string' || !own(option, 'options')) {
    fail(code, method, 'ACP select config shape is invalid', option);
  }
  const parsed: AcpSessionConfigSelectOptionState = { ...base, type: 'select', currentValue: option['currentValue'], options: parseSelectOptions(option['options'], code, method) };
  return parsed;
}

export function parseSessionConfigOptions(value: unknown, code: AcpProtocolFailureCode, method: string): readonly AcpSessionConfigOption[] {
  if (!Array.isArray(value)) fail(code, method, 'ACP configOptions must be an array', value);
  return value.map((option) => parseSessionConfigOption(option, code, method));
}

export function parseAcpInitializeResponse(value: JsonRpcValue): AcpInitializeResponse {
  const response = recordFor(value, 'invalid_initialize_response', ACP_METHODS.initialize);
  if (response['protocolVersion'] !== 1) {
    const code = typeof response['protocolVersion'] === 'number' ? 'unsupported_protocol_version' : 'invalid_initialize_response';
    fail(code, ACP_METHODS.initialize, 'ACP protocol version must be 1', response['protocolVersion']);
  }
  const agentInfoValue = response['agentInfo'];
  const agentInfo = !own(response, 'agentInfo') || agentInfoValue === null ? undefined : parseImplementation(agentInfoValue, 'invalid_initialize_response');
  const agentCapabilities = own(response, 'agentCapabilities') ? parseAgentCapabilities(response['agentCapabilities']) : undefined;
  return { protocolVersion: 1, ...(agentCapabilities === undefined ? {} : { agentCapabilities }), ...(agentInfo === undefined ? {} : { agentInfo }) };
}

export function parseAcpSessionNewResponse(value: JsonRpcValue): AcpNewSessionResponse {
  const response = recordFor(value, 'invalid_session_new_response', ACP_METHODS.newSession);
  const sessionId = nonEmptyString(response, 'sessionId', 'invalid_session_new_response', ACP_METHODS.newSession);
  if (!own(response, 'configOptions')) return { sessionId };
  if (response['configOptions'] === null) return { sessionId, configOptions: null };
  return { sessionId, configOptions: parseSessionConfigOptions(response['configOptions'], 'invalid_session_new_response', ACP_METHODS.newSession) };
}

export function parseAcpSetSessionConfigOptionResponse(value: JsonRpcValue): AcpSetSessionConfigOptionResponse {
  const response = recordFor(value, 'invalid_config_option_response', ACP_METHODS.setSessionConfigOption);
  if (!own(response, 'configOptions')) {
    fail('invalid_config_option_response', ACP_METHODS.setSessionConfigOption, 'ACP set-config response requires configOptions');
  }
  return { configOptions: parseSessionConfigOptions(response['configOptions'], 'invalid_config_option_response', ACP_METHODS.setSessionConfigOption) };
}

function isStopReason(value: unknown): value is AcpStopReason {
  return value === 'end_turn' || value === 'max_tokens' || value === 'max_turn_requests' || value === 'refusal' || value === 'cancelled';
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
