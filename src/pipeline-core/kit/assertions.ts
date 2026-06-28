




import assert from 'node:assert/strict';
import { validateTemplate } from '../validate.js';
import type { Diagnostic, DiagnosticCode, Template } from '../types.js';
import type { DriveResult } from './drive.js';


export function assertValid(template: Template): Diagnostic[] {
  const diags = validateTemplate(template);
  const errors = diags.filter((d) => d.severity === 'error');
  const offending = errors.map((d) => `${d.code}@${d.nodeId ?? d.scope ?? '-'}`).join(', ');
  assert.equal(errors.length, 0, `expected a valid template, got: ${offending}`);
  return diags;
}





export function assertDiagnostics(template: Template, codes: DiagnosticCode[]): Diagnostic[] {
  const diags = validateTemplate(template);
  const got = new Set(diags.filter((d) => d.severity === 'error').map((d) => d.code));
  const want = new Set(codes);
  const missing = [...want].filter((c) => !got.has(c));
  const extra = [...got].filter((c) => !want.has(c));
  assert.ok(
    missing.length === 0 && extra.length === 0,
    `diagnostic codes mismatch\n  missing: [${missing.join(', ')}]\n  extra:   [${extra.join(', ')}]\n  all:     [${[...got].join(', ')}]`,
  );
  return diags;
}


export function assertHasDiagnostic(template: Template, code: DiagnosticCode): Diagnostic {
  const diags = validateTemplate(template);
  const found = diags.find((d) => d.code === code);
  assert.ok(
    found,
    `expected diagnostic "${code}", got: [${diags.map((d) => d.code).join(', ')}]`,
  );
  return found;
}


export function assertNoDiagnostic(template: Template, code: DiagnosticCode): void {
  const diags = validateTemplate(template);
  assert.ok(!diags.some((d) => d.code === code), `unexpected diagnostic "${code}"`);
}


export function assertReachesTerminal(result: DriveResult, status: DriveResult['status']): void {
  assert.equal(result.status, status, `expected terminal "${status}", got "${result.status}" via ${result.path.join(' → ')}`);
}


export function assertPath(result: DriveResult, expected: string[]): void {
  assert.deepEqual(
    result.path,
    expected,
    `path mismatch\n  expected: ${expected.join(' → ')}\n  actual:   ${result.path.join(' → ')}`,
  );
}


export function assertVisitCount(result: DriveResult, nodeId: string, times: number): void {
  const count = result.path.filter((id) => id === nodeId).length;
  assert.equal(count, times, `expected ${nodeId} visited ${times}×, got ${count} (path: ${result.path.join(' → ')})`);
}


export function assertCounter(result: DriveResult, scope: string, value: number): void {
  assert.equal(result.counters[scope] ?? 0, value, `expected counter ${scope}=${value}, got ${result.counters[scope] ?? 0}`);
}
