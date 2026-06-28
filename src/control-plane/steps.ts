/**
 * Step types + deterministic id / format helpers for the control plane.
 *
 * NOTE: the legacy step-lifecycle verbs (`claimNextStep`/`startAttempt`/`writeResult`/`failStep`/
 * `recoverInFlight`/`createSteps`) were the pre-pivot dumb-loop step queue. They are superseded by the
 * DBOS-driven data-driven engine and were removed. What remains here is the `Step` shape the
 * runner machinery still consumes (synthesized in-memory by the engine — `RunService.loadPipelineContext` —
 * not read from a `steps` row) plus a few pure id / format helpers reused across the run / inbox / pipeline
 * layers.
 */

// ─── public types ───────────────────────────────────────────

export type Step = {
  id: string;
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  status: string;
  input: unknown;
  output: unknown;
  modelProfile: string;
  runAfter: string;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  deadReason: string;
};

export type NewStep = {
  taskId: string;
  runId: string;
  role: string;
  kind: string;
  input: unknown;
  modelProfile: string;
  priority?: number;
  maxAttempts?: number;
  dependsOn?: string[];
  runAfter?: string;
};

export type CostRecord = {
  modelProfile: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  currency?: string;
};

// ─── id / format helpers ─────────────────────────────────────

export function compactStamp(date: Date): string {
  const pad = (v: number, l = 2) => String(v).padStart(l, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    'T',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
    pad(date.getUTCMilliseconds(), 3),
    'Z',
  ].join('');
}

// Non-cryptographic FNV-1a 64-bit hash → 16 hex chars. Used to derive DETERMINISTIC, BOUNDED row ids
// (same input → same id, so a crash-retry is idempotent) that fit Revisium's 64-char rowId limit:
// `inbox_`/`event_`/`cost_`/`attempt_`/`out_`/`step_` + 16 hex stays well under the cap. Not crypto, so
// it does not trip the weak-hash security hotspot.
export function fnv1a64Hex(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.codePointAt(i) ?? 0);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}
