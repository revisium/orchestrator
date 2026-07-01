import { ControlPlaneError } from './errors.js';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function nonBlankString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requireAuditRecord(input: unknown, errorMessage: string): Record<string, unknown> {
  const record = asRecord(input);
  if (!record) throw new ControlPlaneError('VALIDATION_FAILURE', errorMessage);
  return record;
}

export function normalizeAuditStringFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  fieldPath: string,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const field of fields) {
    const value = nonBlankString(record, field);
    if (!value) {
      throw new ControlPlaneError('VALIDATION_FAILURE', `${fieldPath}.${field} is required`);
    }
    normalized[field] = value;
  }
  return normalized;
}
