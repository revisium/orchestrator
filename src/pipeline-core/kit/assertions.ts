/**
 * pipeline-core/kit/assertions.ts — readable assertions over validation + drive results.
 *
 * Mirrors the e2e kit's assertion style (`assertCompleted`, `assertEventsPresent`): each helper states
 * an intent in one call with a clear failure message, so the test body reads as a spec sentence.
 */

import assert from 'node:assert/strict';
import { validateTemplate } from '../validate.js';
import type { Diagnostic, DiagnosticCode, Template } from '../types.js';
import type { DriveResult } from './drive.js';

/** Assert the template has NO diagnostics (valid). On failure, prints the offending codes. */
export function assertValid(template: Template): Diagnostic[] {
  const diags = validateTemplate(template);
  const errors = diags.filter((d) => d.severity === 'error');
  assert.equal(
    errors.length,
    0,
    `expected a valid template, got: ${errors.map((d) => `${d.code}@${d.nodeId ?? d.scope ?? '-'}`).join(', ')}`,
  );
  return diags;
}

/**
 * Assert validation produces EXACTLY the expected ERROR codes (set equality, order-free). Advisory
 * WARNING codes (e.g. an unused domain label) are orthogonal to a rule violation and are ignored here
 * — assert those explicitly via {@link assertHasDiagnostic}. Use {@link assertHasDiagnostic} when a
 * fixture legitimately trips several error rules and you assert one.
 */
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

/** Assert at least one diagnostic with `code` was produced (the fixture may trip other rules too). */
export function assertHasDiagnostic(template: Template, code: DiagnosticCode): Diagnostic {
  const diags = validateTemplate(template);
  const found = diags.find((d) => d.code === code);
  assert.ok(
    found,
    `expected diagnostic "${code}", got: [${diags.map((d) => d.code).join(', ')}]`,
  );
  return found;
}

/** Assert NO diagnostic with `code` was produced. */
export function assertNoDiagnostic(template: Template, code: DiagnosticCode): void {
  const diags = validateTemplate(template);
  assert.ok(!diags.some((d) => d.code === code), `unexpected diagnostic "${code}"`);
}

/** Assert a drive reached a terminal with `status`. */
export function assertReachesTerminal(result: DriveResult, status: DriveResult['status']): void {
  assert.equal(result.status, status, `expected terminal "${status}", got "${result.status}" via ${result.path.join(' → ')}`);
}

/** Assert the recorded path of emitted Decisions equals `expected` (node ids, in order). */
export function assertPath(result: DriveResult, expected: string[]): void {
  assert.deepEqual(
    result.path,
    expected,
    `path mismatch\n  expected: ${expected.join(' → ')}\n  actual:   ${result.path.join(' → ')}`,
  );
}

/** Assert a node appears in the path exactly `times` (e.g. a rework node hit at the loop cap). */
export function assertVisitCount(result: DriveResult, nodeId: string, times: number): void {
  const count = result.path.filter((id) => id === nodeId).length;
  assert.equal(count, times, `expected ${nodeId} visited ${times}×, got ${count} (path: ${result.path.join(' → ')})`);
}

/** Assert a scope's final counter value. */
export function assertCounter(result: DriveResult, scope: string, value: number): void {
  assert.equal(result.counters[scope] ?? 0, value, `expected counter ${scope}=${value}, got ${result.counters[scope] ?? 0}`);
}
