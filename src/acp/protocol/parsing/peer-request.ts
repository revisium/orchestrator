import type { JsonRpcParams, JsonRpcRequest } from '../../jsonrpc/types.js';
import { ACP_METHODS } from '../methods.js';
import type { AcpPermissionOption, AcpPermissionRequest, AcpPermissionToolCall } from '../values.js';
import { canonicalObject, fail, nonEmptyString, own, recordFor } from './value-readers.js';

function isPermissionKind(value: unknown): value is AcpPermissionOption['kind'] {
  return value === 'allow_once' || value === 'allow_always' || value === 'reject_once' || value === 'reject_always';
}

function parsePermissionOption(value: unknown): AcpPermissionOption {
  const option = recordFor(value, 'malformed_peer_request', ACP_METHODS.requestPermission);
  const kind = option['kind'];
  if (!own(option, 'kind') || !isPermissionKind(kind)) {
    fail('malformed_peer_request', ACP_METHODS.requestPermission, 'ACP permission option kind is invalid', kind);
  }
  return {
    optionId: nonEmptyString(option, 'optionId', 'malformed_peer_request', ACP_METHODS.requestPermission),
    name: nonEmptyString(option, 'name', 'malformed_peer_request', ACP_METHODS.requestPermission),
    kind,
  };
}

function parsePermissionRequestParams(params: JsonRpcParams): AcpPermissionRequest {
  const request = recordFor(params, 'malformed_peer_request', ACP_METHODS.requestPermission);
  const sessionId = nonEmptyString(request, 'sessionId', 'malformed_peer_request', ACP_METHODS.requestPermission);
  if (!own(request, 'toolCall')) {
    fail('malformed_peer_request', ACP_METHODS.requestPermission, 'ACP permission request requires toolCall');
  }
  const toolCallSnapshot = canonicalObject(request['toolCall'], 'malformed_peer_request', ACP_METHODS.requestPermission);
  const toolCallId = typeof toolCallSnapshot['toolCallId'] === 'string' ? toolCallSnapshot['toolCallId'] : '';
  if (toolCallId.length === 0) {
    fail('malformed_peer_request', ACP_METHODS.requestPermission, 'ACP permission toolCallId must be nonempty');
  }
  const toolCall: AcpPermissionToolCall = { ...toolCallSnapshot, toolCallId };
  const rawOptions = request['options'];
  if (!own(request, 'options') || !Array.isArray(rawOptions)) {
    fail('malformed_peer_request', ACP_METHODS.requestPermission, 'ACP permission options must be an array', rawOptions);
  }
  return { sessionId, toolCall, options: rawOptions.map(parsePermissionOption) };
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
