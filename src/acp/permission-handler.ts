import { Injectable, Scope } from '@nestjs/common';
import type { AcpInteractionDiagnostic } from './interaction-diagnostic.types.js';
import { canonicalizeJsonRpcValue, snapshotJsonRpcRecord } from './jsonrpc/canonicalizer.js';
import type { JsonRpcValue } from './jsonrpc/types.js';

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export type PermissionOption = Readonly<{
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}>;

export type PermissionToolCallSnapshot = Readonly<Record<string, JsonRpcValue>>;

export type PermissionResolutionRequest = Readonly<{
  sessionId: string;
  toolCallId: string;
  toolCallSnapshot: PermissionToolCallSnapshot;
  options: readonly PermissionOption[];
}>;

export type PermissionResolutionDecision =
  | Readonly<{ outcome: 'select'; optionKind: PermissionOptionKind }>
  | Readonly<{ outcome: 'cancel' }>;

export type PermissionResolver = (
  request: PermissionResolutionRequest,
) => Promise<PermissionResolutionDecision>;

export type AcpPermissionHandlerDeps = Readonly<{
  expectedSessionId: string;
  resolvePermission: PermissionResolver;
}>;

export type PermissionCancellationReason =
  | 'malformed-request'
  | 'foreign-session'
  | 'resolver-cancelled'
  | 'required-option-unavailable'
  | 'invalid-decision'
  | 'resolver-failed';

export type RequestPermissionResponse = Readonly<{
  outcome:
    | Readonly<{ outcome: 'selected'; optionId: string }>
    | Readonly<{ outcome: 'cancelled' }>;
}>;

type SelectedPermissionResponse = Readonly<{
  outcome: Extract<RequestPermissionResponse['outcome'], { outcome: 'selected' }>;
}>;

type CancelledPermissionResponse = Readonly<{
  outcome: Extract<RequestPermissionResponse['outcome'], { outcome: 'cancelled' }>;
}>;

export type PermissionHandlingResult =
  | Readonly<{
      outcome: 'selected';
      response: SelectedPermissionResponse;
    }>
  | Readonly<{
      outcome: 'cancelled';
      reason: PermissionCancellationReason;
      response: CancelledPermissionResponse;
      diagnostics: readonly AcpInteractionDiagnostic[];
    }>;

type ParsedPermissionRequest =
  | Readonly<{ outcome: 'valid'; request: PermissionResolutionRequest }>
  | Readonly<{ outcome: 'invalid' }>;

function isPermissionOptionKind(value: unknown): value is PermissionOptionKind {
  return value === 'allow_once' ||
    value === 'allow_always' ||
    value === 'reject_once' ||
    value === 'reject_always';
}

function parsePermissionOption(value: unknown): PermissionOption | undefined {
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
  const options: PermissionOption[] = [];
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

function copyResolutionRequest(request: PermissionResolutionRequest): PermissionResolutionRequest {
  const { sessionId, toolCallId, toolCallSnapshot, options } = request;
  return {
    sessionId,
    toolCallId,
    toolCallSnapshot,
    options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
  };
}

function parseResolutionDecision(value: unknown): PermissionResolutionDecision | undefined {
  const snapshot = snapshotJsonRpcRecord(value);
  if (!snapshot || !Object.hasOwn(snapshot, 'outcome')) return undefined;
  const { outcome: rawOutcome, optionKind: rawOptionKind } = snapshot;
  if (rawOutcome === 'cancel') return { outcome: 'cancel' };
  if (rawOutcome !== 'select') return undefined;
  if (!Object.hasOwn(snapshot, 'optionKind') || !isPermissionOptionKind(rawOptionKind)) return undefined;
  return { outcome: 'select', optionKind: rawOptionKind };
}

const cancellationMessages: Record<PermissionCancellationReason, string> = {
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

function cancelPermission(reason: PermissionCancellationReason): PermissionHandlingResult {
  return {
    outcome: 'cancelled',
    reason,
    response: createCancelledResponse(),
    diagnostics: [{ severity: 'error', reason, message: cancellationMessages[reason] }],
  };
}

@Injectable({ scope: Scope.TRANSIENT })
export class AcpPermissionHandler {
  private deps: AcpPermissionHandlerDeps | undefined;

  bind(deps: AcpPermissionHandlerDeps): void {
    if (this.deps) throw new Error('ACP permission handler is already bound');
    this.deps = deps;
  }

  async handle(params: unknown): Promise<PermissionHandlingResult> {
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

  private requireDeps(): AcpPermissionHandlerDeps {
    if (!this.deps) throw new Error('ACP permission handler is not bound');
    return this.deps;
  }
}
