import { canonicalizeJsonRpcValue, snapshotJsonRpcRecord } from '../../jsonrpc/canonicalizer.js';
import type { JsonRpcValue } from '../../jsonrpc/types.js';
import { AcpProtocolError, type AcpProtocolFailureCode } from '../error.js';
import type { AcpCanonicalObject } from '../values.js';

export function fail(code: AcpProtocolFailureCode, method: string, message: string, details?: unknown): never {
  throw new AcpProtocolError(code, method, message, details);
}

export function own(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

export function recordFor(value: unknown, code: AcpProtocolFailureCode, method: string): Record<string, unknown> {
  let record: Record<string, unknown> | undefined;
  try {
    record = snapshotJsonRpcRecord(value);
  } catch {
    fail(code, method, 'ACP value cannot be inspected safely');
  }
  if (!record) fail(code, method, 'ACP value must be a canonical object');
  return record;
}

export function nonEmptyString(record: Record<string, unknown>, key: string, code: AcpProtocolFailureCode, method: string): string {
  const field = record[key];
  if (!own(record, key) || typeof field !== 'string' || field.length === 0) {
    fail(code, method, `ACP ${key} must be a nonempty string`, field);
  }
  return field;
}

export function canonicalObject(value: unknown, code: AcpProtocolFailureCode, method: string): AcpCanonicalObject {
  let canonical: JsonRpcValue | undefined;
  try {
    canonical = canonicalizeJsonRpcValue(value);
  } catch {
    fail(code, method, 'ACP value cannot be canonicalized safely');
  }
  if (canonical === undefined || canonical === null || Array.isArray(canonical) || typeof canonical !== 'object') {
    fail(code, method, 'ACP value must be a canonical object');
  }
  return canonical;
}

export function optionalNullableString(record: Record<string, unknown>, key: string, code: AcpProtocolFailureCode, method: string): string | null | undefined {
  if (!own(record, key)) return undefined;
  const field = record[key];
  if (field !== null && typeof field !== 'string') {
    fail(code, method, `ACP ${key} must be string or null`, field);
  }
  return field;
}
