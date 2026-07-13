import { ControlPlaneError } from './errors.js';
import type { ControlPlaneTransport } from './transport.js';

export type Role = {
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  scopeRules: unknown;
  playbookId?: string;
  playbookRoleId?: string;
  sourcePath?: string;
  sourceHash?: string;
  surface?: string;
  rights?: string;

};




export type PipelinePolicy = {
  maxReviewIterations: number;
  maxAttempts: number;
  budgetUsd: number;
  budgetTokens: number;
};


export const DEFAULT_PIPELINE_POLICY: PipelinePolicy = {
  maxReviewIterations: 3,
  maxAttempts: 3,
  budgetUsd: 0,
  budgetTokens: 0,
};

function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function parseJsonField(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return {};
  if (typeof value !== 'string') return value;
  return JSON.parse(value) as unknown;
}


function toPosInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}


function toNonNegNum(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}


export function toOptPosInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : undefined;
}


function isRowNotFound(err: unknown): boolean {
  if (err instanceof ControlPlaneError) return err.code === 'ROW_NOT_FOUND';
  const status = (err as { statusCode?: number } | null)?.statusCode;
  return status === 404;
}

export async function loadRole(name: string, transport: ControlPlaneTransport): Promise<Role> {
  const t = transport;
  const row = await t.getRow('roles', name);
  const d = row.data ?? {};
  return {
    name: toStr(d.name) || name,
    systemPrompt: toStr(d.system_prompt),
    allowedTools: Array.isArray(d.allowed_tools) ? (d.allowed_tools as unknown[]).map(toStr) : [],
    scopeRules: parseJsonField(d.scope_rules),
    playbookId: toStr(d.playbook_id) || undefined,
    playbookRoleId: toStr(d.playbook_role_id) || undefined,
    sourcePath: toStr(d.source_path) || undefined,
    sourceHash: toStr(d.source_hash) || undefined,
    surface: toStr(d.surface) || undefined,
    rights: toStr(d.rights) || undefined,
  };
}






export async function loadPipelinePolicy(
  transport: ControlPlaneTransport,
  rowId = 'pipeline',
): Promise<PipelinePolicy> {
  const t = transport;

  let row: { data?: Record<string, unknown> };
  try {
    row = await t.getRow('routing_policy', rowId);
  } catch (err) {
    if (isRowNotFound(err)) return { ...DEFAULT_PIPELINE_POLICY };
    throw err;
  }

  const parsed = parseJsonField(row.data?.rule);
  const rule: Record<string, unknown> =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  return {
    maxReviewIterations: toPosInt(rule.max_review_iterations, DEFAULT_PIPELINE_POLICY.maxReviewIterations),
    maxAttempts: toPosInt(rule.max_attempts, DEFAULT_PIPELINE_POLICY.maxAttempts),
    budgetUsd: toNonNegNum(rule.budget_usd, DEFAULT_PIPELINE_POLICY.budgetUsd),
    budgetTokens: toNonNegNum(rule.budget_tokens, DEFAULT_PIPELINE_POLICY.budgetTokens),
  };
}
