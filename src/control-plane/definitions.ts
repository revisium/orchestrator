import { ControlPlaneError } from './errors.js';
import { createClientTransport, type ControlPlaneTransport } from './client-transport.js';

export type Role = {
  name: string;
  systemPrompt: string;
  modelLevel: 'cheap' | 'standard' | 'deep';
  effort: string;
  runner: 'claude-code' | 'codex' | 'script';
  allowedTools: string[];
  scopeRules: unknown;
};

export type ModelProfile = {
  level: 'cheap' | 'standard' | 'deep';
  provider: string;
  modelId: string;
  params: unknown;
  costPerInput: number;
  costPerOutput: number;
};

const VALID_MODEL_LEVELS = ['cheap', 'standard', 'deep'] as const;

function toModelLevel(raw: unknown): Role['modelLevel'] {
  const s = toStr(raw) || 'standard';
  if (!(VALID_MODEL_LEVELS as readonly string[]).includes(s)) {
    throw new ControlPlaneError(
      'VALIDATION_FAILURE',
      `Invalid model_level "${s}": expected one of ${VALID_MODEL_LEVELS.join(', ')}`,
    );
  }
  return s as Role['modelLevel'];
}

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

export async function loadRole(name: string, transport?: ControlPlaneTransport): Promise<Role> {
  const t = transport ?? createClientTransport('head');
  const row = await t.getRow('roles', name);
  const d = row.data ?? {};
  return {
    name: toStr(d.name) || name,
    systemPrompt: toStr(d.system_prompt),
    modelLevel: toModelLevel(d.model_level),
    effort: toStr(d.effort),
    runner: (toStr(d.runner) || 'claude-code') as Role['runner'],
    allowedTools: Array.isArray(d.allowed_tools) ? (d.allowed_tools as unknown[]).map(toStr) : [],
    scopeRules: parseJsonField(d.scope_rules),
  };
}

export async function loadModelProfile(level: string, transport?: ControlPlaneTransport): Promise<ModelProfile> {
  const t = transport ?? createClientTransport('head');
  const row = await t.getRow('model_profiles', level);
  const d = row.data ?? {};
  return {
    level: (toStr(d.level) || level) as ModelProfile['level'],
    provider: toStr(d.provider),
    modelId: toStr(d.model_id),
    params: parseJsonField(d.params),
    costPerInput: Number(d.cost_per_input ?? 0),
    costPerOutput: Number(d.cost_per_output ?? 0),
  };
}
