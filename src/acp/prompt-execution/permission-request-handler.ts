import type { AcpPromptExecutionDiagnostic } from './diagnostic.js';
import { canonicalizeJsonRpcValue, snapshotJsonRpcRecord } from '../jsonrpc/canonicalizer.js';
import type { JsonRpcValue } from '../jsonrpc/types.js';

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export type AcpPermissionOption = Readonly<{
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}>;

export type AcpPermissionToolCallSnapshot = Readonly<Record<string, JsonRpcValue>>;

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
  expectedSessionId: string;
  resolvePermission: AcpPermissionResolver;
}>;

export type AcpPermissionCancellationReason =
  | 'malformed-request'
  | 'foreign-session'
  | 'resolver-cancelled'
  | 'required-option-unavailable'
  | 'invalid-decision'
  | 'resolver-failed';

export type AcpPermissionResponse = Readonly<{
  outcome:
    | Readonly<{ outcome: 'selected'; optionId: string }>
    | Readonly<{ outcome: 'cancelled' }>;
}>;

type SelectedPermissionResponse = Readonly<{
  outcome: Extract<AcpPermissionResponse['outcome'], { outcome: 'selected' }>;
}>;

type CancelledPermissionResponse = Readonly<{
  outcome: Extract<AcpPermissionResponse['outcome'], { outcome: 'cancelled' }>;
}>;

export type AcpPermissionHandlingResult =
  | Readonly<{
      outcome: 'selected';
      response: SelectedPermissionResponse;
    }>
  | Readonly<{
      outcome: 'cancelled';
      reason: AcpPermissionCancellationReason;
      response: CancelledPermissionResponse;
      diagnostics: readonly AcpPromptExecutionDiagnostic[];
    }>;

type ParsedPermissionRequest =
  | Readonly<{ outcome: 'valid'; request: AcpPermissionResolutionRequest }>
  | Readonly<{ outcome: 'invalid' }>;

function isPermissionOptionKind(value: unknown): value is AcpPermissionOptionKind {
  return value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always';
}

function parsePermissionOption(value: unknown): AcpPermissionOption | undefined {
  const snapshot = snapshotJsonRpcRecord(value);
  if (!snapshot) return undefined;
  const { optionId: rawOptionId, name: rawName, kind: rawKind } = snapshot;
  if (!Object.hasOwn(snapshot, 'optionId') || typeof rawOptionId !== 'string') return undefined;
  if (!Object.hasOwn(snapshot, 'name') || typeof rawName !== 'string') return undefined;
  if (!Object.hasOwn(snapshot, 'kind') || !isPermissionOptionKind(rawKind)) return undefined;
  return { optionId: rawOptionId, name: rawName, kind: rawKind };
}

function invalidPermissionRequest(): ParsedPermissionRequest {
  return { outcome: 'invalid' };
}

function parsePermissionRequest(value: unknown): ParsedPermissionRequest {
  const snapshot = snapshotJsonRpcRecord(value);
  if (!snapshot) return invalidPermissionRequest();
  const { sessionId: rawSessionId, toolCall: rawToolCall, options: rawOptions } = snapshot;
  if (!Object.hasOwn(snapshot, 'sessionId') || typeof rawSessionId !== 'string') {
    return invalidPermissionRequest();
  }
  if (!Object.hasOwn(snapshot, 'toolCall')) {
    return invalidPermissionRequest();
  }
  const canonicalToolCall = canonicalizeJsonRpcValue(rawToolCall);
  if (
    canonicalToolCall === undefined ||
    canonicalToolCall === null ||
    Array.isArray(canonicalToolCall) ||
    typeof canonicalToolCall !== 'object'
  ) {
    return invalidPermissionRequest();
  }
  const rawToolCallId = canonicalToolCall.toolCallId;
  if (
    !Object.hasOwn(canonicalToolCall, 'toolCallId') ||
    typeof rawToolCallId !== 'string' ||
    rawToolCallId.length === 0
  ) {
    return invalidPermissionRequest();
  }
  if (!Object.hasOwn(snapshot, 'options')) {
    return invalidPermissionRequest();
  }
  const canonicalOptions = canonicalizeJsonRpcValue(rawOptions);
  if (!Array.isArray(canonicalOptions)) return invalidPermissionRequest();
  const options: AcpPermissionOption[] = [];
  for (const rawOption of canonicalOptions) {
    const option = parsePermissionOption(rawOption);
    if (!option) return invalidPermissionRequest();
    options.push(option);
  }
  return {
    outcome: 'valid',
    request: {
      sessionId: rawSessionId,
      toolCallId: rawToolCallId,
      toolCallSnapshot: canonicalToolCall,
      options,
    },
  };
}

function copyResolutionRequest(request: AcpPermissionResolutionRequest): AcpPermissionResolutionRequest {
  const { sessionId, toolCallId, toolCallSnapshot, options } = request;
  return {
    sessionId,
    toolCallId,
    toolCallSnapshot,
    options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
  };
}

function parseResolutionDecision(value: unknown): AcpPermissionResolutionDecision | undefined {
  const snapshot = snapshotJsonRpcRecord(value);
  if (!snapshot || !Object.hasOwn(snapshot, 'outcome')) return undefined;
  const { outcome: rawOutcome, optionKind: rawOptionKind } = snapshot;
  if (rawOutcome === 'cancel') return { outcome: 'cancel' };
  if (rawOutcome !== 'select') return undefined;
  if (!Object.hasOwn(snapshot, 'optionKind') || !isPermissionOptionKind(rawOptionKind)) return undefined;
  return { outcome: 'select', optionKind: rawOptionKind };
}

const cancellationMessages: Record<AcpPermissionCancellationReason, string> = {
  'malformed-request': 'Permission request is malformed',
  'foreign-session': 'Permission request belongs to another session',
  'resolver-cancelled': 'Permission resolver cancelled the request',
  'required-option-unavailable': 'Required permission option was not offered',
  'invalid-decision': 'Permission resolver returned an invalid decision',
  'resolver-failed': 'Permission resolver failed',
};

function createCancelledResponse(): CancelledPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

function cancelPermission(reason: AcpPermissionCancellationReason): AcpPermissionHandlingResult {
  return {
    outcome: 'cancelled',
    reason,
    response: createCancelledResponse(),
    diagnostics: [{ severity: 'error', reason, message: cancellationMessages[reason] }],
  };
}

export class AcpPermissionRequestHandler {
  private deps: AcpPermissionRequestHandlerDeps | undefined;

  bind(deps: AcpPermissionRequestHandlerDeps): void {
    if (this.deps) throw new Error('ACP permission handler is already bound');
    this.deps = deps;
  }

  async handle(params: unknown): Promise<AcpPermissionHandlingResult> {
    const deps = this.requireDeps();
    const { expectedSessionId } = deps;
    const parsed = parsePermissionRequest(params);
    if (parsed.outcome === 'invalid') return cancelPermission('malformed-request');

    const { request } = parsed;
    const { sessionId: requestSessionId, options } = request;
    if (requestSessionId !== expectedSessionId) return cancelPermission('foreign-session');

    let rawDecision: unknown;
    try {
      rawDecision = await deps.resolvePermission(copyResolutionRequest(request));
    } catch {
      return cancelPermission('resolver-failed');
    }
    const decision = parseResolutionDecision(rawDecision);
    if (!decision) return cancelPermission('invalid-decision');
    if (decision.outcome === 'cancel') return cancelPermission('resolver-cancelled');
    const { optionKind } = decision;
    const selectedOption = options.find((option) => option.kind === optionKind);
    if (!selectedOption) return cancelPermission('required-option-unavailable');
    const { optionId } = selectedOption;
    return {
      outcome: 'selected',
      response: { outcome: { outcome: 'selected', optionId } },
    };
  }

  private requireDeps(): AcpPermissionRequestHandlerDeps {
    if (!this.deps) throw new Error('ACP permission handler is not bound');
    return this.deps;
  }
}
