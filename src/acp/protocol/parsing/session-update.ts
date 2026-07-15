import type { JsonRpcParams } from '../../jsonrpc/types.js';
import { ACP_METHODS } from '../methods.js';
import type {
  AcpCanonicalObject, AcpReportedCost, AcpSessionActivitySnapshot, AcpSessionNotification,
  AcpSessionUpdate, AcpSessionUpdateDiscriminator,
} from '../values.js';
import { parseSessionConfigOptions } from './lifecycle-responses.js';
import { canonicalObject, fail, nonEmptyString, optionalNullableString, own, recordFor } from './value-readers.js';

function malformedNotification(message: string, details?: unknown): never {
  fail('malformed_peer_notification', ACP_METHODS.sessionUpdate, message, details);
}

function requireCanonicalArray(value: unknown, field: string): readonly AcpCanonicalObject[] {
  if (!Array.isArray(value)) malformedNotification(`ACP ${field} must be an array`, value);
  return value.map((entry) => canonicalObject(entry, 'malformed_peer_notification', ACP_METHODS.sessionUpdate));
}

function requireContent(update: AcpCanonicalObject): AcpCanonicalObject {
  if (!Object.hasOwn(update, 'content')) malformedNotification('ACP update content is required');
  return canonicalObject(update['content'], 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
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
    const resource = canonicalObject(content['resource'], 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
    if (typeof resource['uri'] !== 'string') malformedNotification('ACP embedded resource requires uri', resource);
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
    const cost = canonicalObject(update['cost'], 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
    const amount = cost['amount'];
    const currency = cost['currency'];
    if (typeof amount !== 'number' || !Number.isFinite(amount) || typeof currency !== 'string' || currency.length === 0) {
      malformedNotification('ACP reported cost is invalid', cost);
    }
    reportedCost = { amount, currency };
  }
  return { kind: 'usage', used, size, ...(reportedCost === undefined ? {} : { reportedCost }) };
}

function validateActivity(
  discriminator: Exclude<AcpSessionUpdateDiscriminator, 'agent_message_chunk' | 'config_option_update' | 'usage_update'>,
  update: AcpCanonicalObject,
): void {
  switch (discriminator) {
    case 'user_message_chunk':
    case 'agent_thought_chunk':
      requireContent(update);
      return;
    case 'tool_call':
      if (typeof update['toolCallId'] !== 'string' || update['toolCallId'].length === 0 || typeof update['title'] !== 'string') {
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
      optionalNullableString(update, 'title', 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
      optionalNullableString(update, 'updatedAt', 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
  }
}

function parseSessionUpdateParams(params: JsonRpcParams): AcpSessionNotification {
  const notification = recordFor(params, 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
  const sessionId = nonEmptyString(notification, 'sessionId', 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
  if (!own(notification, 'update')) malformedNotification('ACP session update is required');
  const update = canonicalObject(notification['update'], 'malformed_peer_notification', ACP_METHODS.sessionUpdate);
  const discriminator = update['sessionUpdate'];
  if (typeof discriminator !== 'string') {
    malformedNotification('ACP sessionUpdate discriminator must be a string', discriminator);
  }
  if (discriminator === 'agent_message_chunk') {
    const content = requireContent(update);
    if (content['type'] === 'text') {
      if (typeof content['text'] !== 'string') malformedNotification('ACP text content requires text', content);
      return { sessionId, update: { kind: 'agent-text', text: content['text'] } };
    }
    validateNonTextContent(content);
    const snapshot: AcpSessionActivitySnapshot = { ...update, sessionUpdate: discriminator };
    return { sessionId, update: { kind: 'activity', activityKind: 'agent_message_chunk', snapshot } };
  }
  if (discriminator === 'usage_update') return { sessionId, update: parseUsageUpdate(update) };
  if (discriminator === 'config_option_update') {
    const snapshot: AcpSessionActivitySnapshot = { ...update, sessionUpdate: discriminator };
    return {
      sessionId,
      update: {
        kind: 'activity',
        activityKind: 'config_option_update',
        configOptions: parseSessionConfigOptions(update['configOptions'], 'malformed_peer_notification', ACP_METHODS.sessionUpdate),
        snapshot,
      },
    };
  }
  const activityDiscriminators = [
    'user_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update',
    'plan', 'available_commands_update', 'current_mode_update', 'session_info_update',
  ] as const;
  const activityKind = activityDiscriminators.find((candidate) => candidate === discriminator);
  if (!activityKind) {
    fail('unsupported_session_update', ACP_METHODS.sessionUpdate, 'Unsupported ACP session update', discriminator);
  }
  validateActivity(activityKind, update);
  return { sessionId, update: { kind: 'activity', activityKind, snapshot: { ...update, sessionUpdate: activityKind } } };
}

export function parseAcpPeerNotification(notification: Readonly<{ method: string; params?: JsonRpcParams }>): AcpSessionNotification {
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
