import type {
  AcpCanonicalObject,
  AcpPermissionOption,
  AcpPermissionOptionKind,
  AcpPermissionRequest,
  AcpPermissionResponse,
} from '../protocol/values.js';
import type { AcpPromptExecutionDiagnostic } from './diagnostic.js';

export type AcpPermissionToolCallSnapshot = AcpCanonicalObject;
export type AcpPermissionResolutionRequest = Readonly<{
  sessionId: string;
  toolCallId: string;
  toolCallSnapshot: AcpPermissionToolCallSnapshot;
  options: readonly AcpPermissionOption[];
}>;
export type AcpPermissionResolutionDecision =
  | Readonly<{ outcome: 'select'; optionKind: AcpPermissionOptionKind }>
  | Readonly<{ outcome: 'cancel' }>;
export type AcpPermissionResolver = (
  request: AcpPermissionResolutionRequest,
) => Promise<AcpPermissionResolutionDecision>;
export type AcpPermissionRequestHandlerDeps = Readonly<{
  resolvePermission: AcpPermissionResolver;
}>;
export type AcpPermissionCancellationReason =
  | 'resolver-cancelled'
  | 'required-option-unavailable'
  | 'invalid-decision'
  | 'resolver-failed';
export type AcpPermissionHandlingResult =
  | Readonly<{ outcome: 'selected'; response: AcpPermissionResponse }>
  | Readonly<{
      outcome: 'cancelled';
      reason: AcpPermissionCancellationReason;
      response: AcpPermissionResponse;
      diagnostics: readonly AcpPromptExecutionDiagnostic[];
    }>;

type AcpCanonicalValue = AcpCanonicalObject[string];

const CANCELLATION_MESSAGES: Readonly<Record<AcpPermissionCancellationReason, string>> = {
  'resolver-cancelled': 'Permission resolver cancelled the request',
  'required-option-unavailable': 'Required permission option was not offered',
  'invalid-decision': 'Permission resolver returned an invalid decision',
  'resolver-failed': 'Permission resolver failed',
};

function copyCanonicalValue(value: AcpCanonicalValue): AcpCanonicalValue {
  if (Array.isArray(value)) return value.map(copyCanonicalValue);
  if (value !== null && typeof value === 'object') {
    const copied: Record<string, AcpCanonicalValue> = {};
    for (const key of Object.keys(value)) copied[key] = copyCanonicalValue(value[key]!);
    return copied;
  }
  return value;
}

function copyToolCall(toolCall: AcpCanonicalObject): AcpPermissionToolCallSnapshot {
  const copied: Record<string, AcpCanonicalValue> = {};
  for (const key of Object.keys(toolCall)) copied[key] = copyCanonicalValue(toolCall[key]!);
  return copied;
}

function snapshotDecision(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return undefined;
      Object.defineProperty(snapshot, key, {
        enumerable: true,
        value: descriptor.value,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function isPermissionOptionKind(value: unknown): value is AcpPermissionOptionKind {
  return value === 'allow_once' || value === 'allow_always' ||
    value === 'reject_once' || value === 'reject_always';
}

function parseDecision(value: unknown): AcpPermissionResolutionDecision | undefined {
  const decision = snapshotDecision(value);
  if (!decision || !Object.hasOwn(decision, 'outcome')) return undefined;
  if (decision['outcome'] === 'cancel') return { outcome: 'cancel' };
  if (decision['outcome'] !== 'select' || !Object.hasOwn(decision, 'optionKind') ||
      !isPermissionOptionKind(decision['optionKind'])) return undefined;
  return { outcome: 'select', optionKind: decision['optionKind'] };
}

function cancelPermission(
  reason: AcpPermissionCancellationReason,
): AcpPermissionHandlingResult {
  return {
    outcome: 'cancelled',
    reason,
    response: { outcome: { outcome: 'cancelled' } },
    diagnostics: [{ severity: 'error', reason, message: CANCELLATION_MESSAGES[reason] }],
  };
}

export class AcpPermissionRequestHandler {
  private deps: AcpPermissionRequestHandlerDeps | undefined;

  bind(deps: AcpPermissionRequestHandlerDeps): void {
    if (this.deps) throw new Error('ACP permission handler is already bound');
    this.deps = deps;
  }

  async handle(request: AcpPermissionRequest): Promise<AcpPermissionHandlingResult> {
    if (!this.deps) throw new Error('ACP permission handler is not bound');
    const { sessionId, toolCall, options } = request;
    let rawDecision: unknown;
    try {
      rawDecision = await this.deps.resolvePermission({
        sessionId,
        toolCallId: toolCall.toolCallId,
        toolCallSnapshot: copyToolCall(toolCall),
        options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      });
    } catch {
      return cancelPermission('resolver-failed');
    }
    const decision = parseDecision(rawDecision);
    if (!decision) return cancelPermission('invalid-decision');
    if (decision.outcome === 'cancel') return cancelPermission('resolver-cancelled');
    const selected = options.find(({ kind }) => kind === decision.optionKind);
    if (!selected) return cancelPermission('required-option-unavailable');
    return {
      outcome: 'selected',
      response: { outcome: { outcome: 'selected', optionId: selected.optionId } },
    };
  }
}
