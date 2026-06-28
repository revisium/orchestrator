





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
