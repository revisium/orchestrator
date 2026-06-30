import { ControlPlaneError } from './errors.js';
import type { InboxItem } from './inbox.js';

export type ManualAdoptionAudit = {
  runId: string;
  step: string;
  role: string;
  targetRepo: string;
  targetBranch: string;
  actor: string;
  scope: string;
  risk: string;
  verificationResponsibility: string;
  artifactRef?: string;
  worktreeRef?: string;
};

export type ManualAdoptionAuditInput = Partial<ManualAdoptionAudit>;

const REQUIRED_STRING_FIELDS = [
  'runId',
  'step',
  'role',
  'targetRepo',
  'targetBranch',
  'actor',
  'scope',
  'risk',
  'verificationResponsibility',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonBlankString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function adoptionAuditContextRunId(item: InboxItem): string | undefined {
  if (typeof item.runId === 'string' && item.runId.trim().length > 0) return item.runId;
  const context = asRecord(item.context);
  const runId = context ? nonBlankString(context, 'runId') : undefined;
  return runId;
}

export function validateManualAdoptionAudit(input: unknown, item: InboxItem): ManualAdoptionAudit {
  const record = asRecord(input);
  if (!record) {
    throw new ControlPlaneError('VALIDATION_FAILURE', 'adopt_patch_manually requires adoptionAudit');
  }

  const normalized: Record<string, string> = {};
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = nonBlankString(record, field);
    if (!value) {
      throw new ControlPlaneError('VALIDATION_FAILURE', `adopt_patch_manually adoptionAudit.${field} is required`);
    }
    normalized[field] = value;
  }

  const artifactRef = nonBlankString(record, 'artifactRef');
  const worktreeRef = nonBlankString(record, 'worktreeRef');
  if (!artifactRef && !worktreeRef) {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      'adopt_patch_manually adoptionAudit requires artifactRef or worktreeRef',
    );
  }

  const contextRunId = adoptionAuditContextRunId(item);
  if (contextRunId && normalized.runId !== contextRunId) {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `adopt_patch_manually adoptionAudit.runId must match gate runId ${contextRunId}`,
    );
  }

  return {
    runId: normalized.runId,
    step: normalized.step,
    role: normalized.role,
    targetRepo: normalized.targetRepo,
    targetBranch: normalized.targetBranch,
    actor: normalized.actor,
    scope: normalized.scope,
    risk: normalized.risk,
    verificationResponsibility: normalized.verificationResponsibility,
    ...(artifactRef ? { artifactRef } : {}),
    ...(worktreeRef ? { worktreeRef } : {}),
  };
}

