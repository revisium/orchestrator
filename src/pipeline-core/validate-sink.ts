/**
 * validate-sink — the shared error/warning collector every §12 rule writes into.
 *
 * Lifted out of validate.ts so each rule module can take a `DiagSink` by type without a circular import
 * back into the orchestrator. `validateTemplate` constructs one and passes it to every rule; rules only
 * call `error`/`warn` on the instance they are handed.
 */

import type { Diagnostic, DiagnosticCode } from './types.js';

export class DiagSink {
  readonly items: Diagnostic[] = [];
  error(code: DiagnosticCode, message: string, where: Partial<Diagnostic> = {}): void {
    this.items.push({ code, severity: 'error', message, ...strip(where) });
  }
  warn(code: DiagnosticCode, message: string, where: Partial<Diagnostic> = {}): void {
    this.items.push({ code, severity: 'warning', message, ...strip(where) });
  }
}

function strip(where: Partial<Diagnostic>): Partial<Diagnostic> {
  const out: Partial<Diagnostic> = {};
  if (where.nodeId !== undefined) out.nodeId = where.nodeId;
  if (where.scope !== undefined) out.scope = where.scope;
  if (where.path !== undefined) out.path = where.path;
  return out;
}
