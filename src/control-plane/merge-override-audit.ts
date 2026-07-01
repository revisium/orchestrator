import { ControlPlaneError } from './errors.js';
import type { InboxItem } from './inbox.js';
import { asRecord, nonBlankString, requireAuditRecord, normalizeAuditStringFields } from './audit-validation-helpers.js';

export type MergeOverrideAudit = {
  threadIds: string[];
  actor: string;
  reason: string;
  risk: string;
  verificationResponsibility: string;
  headSha: string;
  fingerprint?: string;
};

export type MergeOverrideAuditInput = Partial<MergeOverrideAudit>;

const REQUIRED_STRING_FIELDS = [
  'actor',
  'reason',
  'risk',
  'verificationResponsibility',
  'headSha',
] as const;

function overrideAuditContextRunId(item: InboxItem): string | undefined {
  if (typeof item.runId === 'string' && item.runId.trim().length > 0) return item.runId;
  const context = asRecord(item.context);
  if (context && typeof context.runId === 'string' && context.runId.trim().length > 0) return context.runId.trim();
  return undefined;
}

export function validateMergeOverrideAudit(input: unknown, item: InboxItem): MergeOverrideAudit {
  const record = requireAuditRecord(input, 'override_merge requires mergeOverrideAudit');
  const normalized = normalizeAuditStringFields(record, REQUIRED_STRING_FIELDS, 'override_merge mergeOverrideAudit');

  const threadIds = record['threadIds'];
  if (!Array.isArray(threadIds) || threadIds.length === 0) {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'override_merge mergeOverrideAudit.threadIds must be a non-empty array');
  }
  const validThreadIds = threadIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
  if (validThreadIds.length !== threadIds.length) {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'override_merge mergeOverrideAudit.threadIds must contain non-empty strings');
  }

  const contextRunId = overrideAuditContextRunId(item);
  if (!contextRunId) {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'override_merge requires a gate runId to validate the override headSha');
  }

  const fingerprint = nonBlankString(record, 'fingerprint');

  return {
    threadIds: validThreadIds,
    actor: normalized.actor,
    reason: normalized.reason,
    risk: normalized.risk,
    verificationResponsibility: normalized.verificationResponsibility,
    headSha: normalized.headSha,
    ...(fingerprint ? { fingerprint } : {}),
  };
}
