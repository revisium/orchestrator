import { normalizeIssueRefIntoParams } from '../run/issue-ref.js';

export type BindingOverrideMatch = { roleId?: string; nodeId?: string; runnerId?: string };

export type BindingOverride = {
  match: BindingOverrideMatch;
  runnerId?: string;
  modelLevel?: string;
  timeoutMs?: number;
  permissionMode?: string;
};

export type LaunchOverrides = {
  runnerId?: string;
  modelLevel?: string;
  timeoutMs?: number;
  permissionMode?: string;
};

export type RouteRoleBinding = {
  roleId: string;
  rowId: string;
  modelLevel: string;
  runnerId: string;
  resolvedRunnerId: string;
  runnerSource: 'playbook' | 'profile';
  resolvedModelLevel?: string;
  modelSource?: 'playbook' | 'profile';
  timeoutMs?: number;
  resolvedTimeoutMs?: number;
  timeoutSource?: 'playbook' | 'profile';
  permissionMode?: string;
  resolvedPermissionMode?: string;
  permissionSource?: 'playbook' | 'profile';
};

export type RouteDecision = {
  playbookId: string;
  pipelineId: string;
  pipelineRowId: string;
  source: 'explicit';
  roles: string[];
  requiredRoles: string[];
  optionalRoles: string[];
  routeGates: string[];
  executionPolicy: unknown;
  launchBindings: BindingOverride[];
  roleBindings: RouteRoleBinding[];
  params: Record<string, unknown>;
  requestedPipelineId?: string;
  basePipelineId?: string;
  profileSource?: 'stored' | 'inline';
  profileId?: string;
  profileVersion?: string;
  profileHash?: string;
  profileSnapshot?: unknown;
  materializedTemplateHash?: string;
  materializedTemplate?: unknown;
  materializerVersion?: string;
  policyVersion?: string;
};

function findLastBindingOverride(
  overrides: BindingOverride[],
  predicate: (override: BindingOverride) => boolean,
): BindingOverride | undefined {
  for (let index = overrides.length - 1; index >= 0; index -= 1) {
    const override = overrides[index]!;
    if (predicate(override)) return override;
  }
  return undefined;
}

export const RUNNER_PERMISSION_MODES: Record<string, string[]> = {
  'claude-code': ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  'codex': ['read-only', 'workspace-write'],
};

const GATE_ID_BY_CANONICAL_LABEL: Record<string, string> = {
  'task spec approval': 'plan',
  'merge approval': 'merge',
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeParams(value: unknown, issueRef?: unknown, issueAction?: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return normalizeIssueRefIntoParams({}, issueRef, issueAction);
  return normalizeIssueRefIntoParams(record, issueRef, issueAction);
}

export function normalizeRouteGates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const gate = item.trim();
    if (!gate) continue;
    const normalized = GATE_ID_BY_CANONICAL_LABEL[gate.toLowerCase()] ?? gate;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveRunnerForRole(
  runnerId: string,
  roleId: string,
  bindingOverrides: BindingOverride[],
): { runnerId: string; source: RouteRoleBinding['runnerSource'] } {
  const roleLevel = findLastBindingOverride(bindingOverrides, (override) =>
    override.match.roleId === roleId && !override.match.nodeId && override.runnerId !== undefined,
  );
  if (roleLevel?.runnerId) {
    return {
      runnerId: roleLevel.runnerId,
      source: 'profile',
    };
  }
  return { runnerId, source: 'playbook' };
}

type RoleForBinding = {
  modelLevel: string;
  timeoutMs?: number;
  permissionMode?: string;
};

type BindingResolution = {
  resolvedModelLevel: string;
  modelSource: 'playbook' | 'profile';
  resolvedTimeoutMs?: number;
  timeoutSource?: 'playbook' | 'profile';
  resolvedPermissionMode?: string;
  permissionSource?: 'playbook' | 'profile';
};

function overridesForRole(roleId: string, resolvedRunnerId: string, overrides: BindingOverride[]): {
  roleLevel: BindingOverride | undefined;
  runnerLevel: BindingOverride | undefined;
} {
  const roleLevel = findLastBindingOverride(overrides, (o) => o.match.roleId === roleId && !o.match.nodeId);
  const runnerLevel = findLastBindingOverride(overrides, (o) => o.match.runnerId === resolvedRunnerId && !o.match.nodeId && !o.match.roleId);
  return { roleLevel, runnerLevel };
}

export function resolveBindingForRole(
  role: RoleForBinding,
  roleId: string,
  resolvedRunnerId: string,
  bindingOverrides: BindingOverride[],
): BindingResolution {
  const { roleLevel, runnerLevel } = overridesForRole(roleId, resolvedRunnerId, bindingOverrides);

  const modelOverride = roleLevel?.modelLevel ?? runnerLevel?.modelLevel;
  const timeoutOverride = roleLevel?.timeoutMs ?? runnerLevel?.timeoutMs;
  const permOverride = roleLevel?.permissionMode ?? runnerLevel?.permissionMode;

  const result: BindingResolution = {
    resolvedModelLevel: modelOverride ?? role.modelLevel,
    modelSource: modelOverride ? 'profile' : 'playbook',
  };

  if (role.timeoutMs !== undefined || timeoutOverride !== undefined) {
    result.resolvedTimeoutMs = timeoutOverride ?? role.timeoutMs;
    result.timeoutSource = timeoutOverride !== undefined ? 'profile' : 'playbook';
  }

  if (role.permissionMode !== undefined || permOverride !== undefined) {
    result.resolvedPermissionMode = permOverride ?? role.permissionMode;
    result.permissionSource = permOverride !== undefined ? 'profile' : 'playbook';
  }

  return result;
}

export function resolveLaunchOverrides(
  binding: RouteRoleBinding,
  nodeId: string,
  bindingOverrides: BindingOverride[],
): LaunchOverrides | undefined {
  const nodeOverride = findLastBindingOverride(bindingOverrides, (o) => o.match.nodeId === nodeId);

  if (!nodeOverride) {
    const hasAny =
      binding.resolvedModelLevel !== undefined ||
      binding.resolvedTimeoutMs !== undefined ||
      binding.resolvedPermissionMode !== undefined;
    if (!hasAny) return undefined;
    const lo: LaunchOverrides = {};
    if (binding.resolvedModelLevel && binding.modelSource === 'profile') lo.modelLevel = binding.resolvedModelLevel;
    if (binding.resolvedTimeoutMs !== undefined && binding.timeoutSource === 'profile') lo.timeoutMs = binding.resolvedTimeoutMs;
    if (binding.resolvedPermissionMode && binding.permissionSource === 'profile') lo.permissionMode = binding.resolvedPermissionMode;
    return Object.keys(lo).length > 0 ? lo : undefined;
  }

  const lo: LaunchOverrides = {};

  if (nodeOverride.runnerId) {
    lo.runnerId = nodeOverride.runnerId;
  }

  const modelLevel = nodeOverride.modelLevel ?? (binding.modelSource === 'profile' ? binding.resolvedModelLevel : undefined);
  if (modelLevel) lo.modelLevel = modelLevel;

  const timeoutMs = nodeOverride.timeoutMs ?? (binding.timeoutSource === 'profile' ? binding.resolvedTimeoutMs : undefined);
  if (timeoutMs !== undefined) lo.timeoutMs = timeoutMs;

  const permissionMode = nodeOverride.permissionMode ?? (binding.permissionSource === 'profile' ? binding.resolvedPermissionMode : undefined);
  if (permissionMode) lo.permissionMode = permissionMode;

  return Object.keys(lo).length > 0 ? lo : undefined;
}

export function dispatchRunnerId(runnerId: string): string {
  if (runnerId === 'stub-agent') return 'script';
  if (runnerId === 'claude-code' || runnerId === 'codex' || runnerId === 'script') return runnerId;
  return runnerId.startsWith('revo-') ? 'script' : runnerId;
}

export function runnerNeedsLivePreflight(runnerId: string): boolean {
  return runnerId === 'claude-code' || runnerId === 'codex' || runnerId === 'revo-integrator' || runnerId === 'revo-merger';
}

export function runnerUsesRealIntegrator(runnerId: string): boolean {
  return runnerId === 'revo-integrator' || runnerId === 'revo-merger';
}
