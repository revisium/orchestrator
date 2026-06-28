









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
