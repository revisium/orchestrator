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

export type ExecutionProfile = {
  id: string;
  runnerOverrides: Record<string, string>;
  availableRunners?: string[];
  bindingOverrides?: BindingOverride[];
};

export type RouteRoleBinding = {
  roleId: string;
  rowId: string;
  modelLevel: string;
  runnerId: string;
  resolvedRunnerId: string;
  runnerSource: 'playbook' | 'execution-profile';
  resolvedModelLevel?: string;
  modelSource?: 'playbook' | 'execution-profile';
  timeoutMs?: number;
  resolvedTimeoutMs?: number;
  timeoutSource?: 'playbook' | 'execution-profile';
  permissionMode?: string;
  resolvedPermissionMode?: string;
  permissionSource?: 'playbook' | 'execution-profile';
};

export type RouteDecision = {
  playbookId: string;
  pipelineId: string;
  pipelineRowId: string;
  source: 'explicit' | 'deterministic-installed-playbook';
  roles: string[];
  requiredRoles: string[];
  optionalRoles: string[];
  routeGates: string[];
  executionPolicy: unknown;
  executionProfile: ExecutionProfile;
  roleBindings: RouteRoleBinding[];
  params: Record<string, unknown>;
  requestedPipelineId?: string;
  basePipelineId?: string;
  profileId?: string;
  profileVersion?: string;
  profileHash?: string;
  materializedTemplateHash?: string;
  materializerVersion?: string;
  policyVersion?: string;
};

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

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && item.trim() !== '') out[key] = item;
  }
  return out;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function normalizeBindingOverride(raw: unknown): BindingOverride | null {
  const obj = asRecord(raw);
  if (!obj) return null;
  const matchRaw = asRecord(obj.match);
  if (!matchRaw) return null;
  const match: BindingOverrideMatch = {};
  if (typeof matchRaw.roleId === 'string' && matchRaw.roleId.trim()) match.roleId = matchRaw.roleId.trim();
  if (typeof matchRaw.nodeId === 'string' && matchRaw.nodeId.trim()) match.nodeId = matchRaw.nodeId.trim();
  if (typeof matchRaw.runnerId === 'string' && matchRaw.runnerId.trim()) match.runnerId = matchRaw.runnerId.trim();
  const override: BindingOverride = { match };
  if (typeof obj.runnerId === 'string' && obj.runnerId.trim()) override.runnerId = obj.runnerId.trim();
  if (typeof obj.modelLevel === 'string' && obj.modelLevel.trim()) override.modelLevel = obj.modelLevel.trim();
  // Preserve a provided-but-invalid timeoutMs (rather than normalizing it away to undefined) so
  // Phase A's PROFILE_SCHEMA_CLOSED range check can reject it instead of silently ignoring it.
  if (obj.timeoutMs !== undefined) {
    override.timeoutMs = typeof obj.timeoutMs === 'number' ? obj.timeoutMs : Number(obj.timeoutMs);
  }
  if (typeof obj.permissionMode === 'string' && obj.permissionMode.trim()) override.permissionMode = obj.permissionMode.trim();
  return override;
}

function parseBindingOverrides(camel: unknown, snake: unknown): BindingOverride[] | undefined {
  const camelArr = Array.isArray(camel) ? camel : undefined;
  const snakeArr = Array.isArray(snake) ? snake : undefined;
  const raw = [...(camelArr ?? []), ...(snakeArr ?? [])];
  if (raw.length === 0) return undefined;
  const parsed = raw.map(normalizeBindingOverride).filter((e): e is BindingOverride => e !== null);
  return parsed.length > 0 ? parsed : undefined;
}

export function normalizeParams(value: unknown, issueRef?: unknown, issueAction?: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return normalizeIssueRefIntoParams({}, issueRef, issueAction);
  const {
    executionProfile: _executionProfile,
    execution_profile: _executionProfileSnake,
    runnerOverrides: _runnerOverrides,
    runner_overrides: _runnerOverridesSnake,
    availableRunners: _availableRunners,
    available_runners: _availableRunnersSnake,
    ...publicParams
  } = record;
  return normalizeIssueRefIntoParams(publicParams, issueRef, issueAction);
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

export function normalizeExecutionProfile(value?: unknown): ExecutionProfile {
  const raw = asRecord(value) ?? {};
  const bindingOverrides = parseBindingOverrides(raw.bindingOverrides, raw.binding_overrides);
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : 'default',
    runnerOverrides: {
      ...asStringMap(raw.runnerOverrides),
      ...asStringMap(raw.runner_overrides),
    },
    availableRunners: asStringArray(raw.availableRunners) ?? asStringArray(raw.available_runners),
    ...(bindingOverrides ? { bindingOverrides } : {}),
  };
}

export function resolveRunnerForProfile(
  runnerId: string,
  executionProfile: ExecutionProfile,
): { runnerId: string; source: RouteRoleBinding['runnerSource'] } {
  const resolved = executionProfile.runnerOverrides[runnerId];
  if (resolved) return { runnerId: resolved, source: 'execution-profile' };
  return { runnerId, source: 'playbook' };
}

type RoleForBinding = {
  modelLevel: string;
  timeoutMs?: number;
  permissionMode?: string;
};

type BindingResolution = {
  resolvedModelLevel: string;
  modelSource: 'playbook' | 'execution-profile';
  resolvedTimeoutMs?: number;
  timeoutSource?: 'playbook' | 'execution-profile';
  resolvedPermissionMode?: string;
  permissionSource?: 'playbook' | 'execution-profile';
};

function overridesForRole(roleId: string, resolvedRunnerId: string, overrides: BindingOverride[]): {
  roleLevel: BindingOverride | undefined;
  runnerLevel: BindingOverride | undefined;
} {
  const roleLevel = overrides.find((o) => o.match.roleId === roleId && !o.match.nodeId);
  const runnerLevel = overrides.find((o) => o.match.runnerId === resolvedRunnerId && !o.match.nodeId && !o.match.roleId);
  return { roleLevel, runnerLevel };
}

export function resolveBindingForRole(
  role: RoleForBinding,
  roleId: string,
  resolvedRunnerId: string,
  executionProfile: ExecutionProfile,
): BindingResolution {
  const overrides = executionProfile.bindingOverrides ?? [];
  const { roleLevel, runnerLevel } = overridesForRole(roleId, resolvedRunnerId, overrides);

  const modelOverride = roleLevel?.modelLevel ?? runnerLevel?.modelLevel;
  const timeoutOverride = roleLevel?.timeoutMs ?? runnerLevel?.timeoutMs;
  const permOverride = roleLevel?.permissionMode ?? runnerLevel?.permissionMode;

  const result: BindingResolution = {
    resolvedModelLevel: modelOverride ?? role.modelLevel,
    modelSource: modelOverride ? 'execution-profile' : 'playbook',
  };

  if (role.timeoutMs !== undefined || timeoutOverride !== undefined) {
    result.resolvedTimeoutMs = timeoutOverride ?? role.timeoutMs;
    result.timeoutSource = timeoutOverride !== undefined ? 'execution-profile' : 'playbook';
  }

  if (role.permissionMode !== undefined || permOverride !== undefined) {
    result.resolvedPermissionMode = permOverride ?? role.permissionMode;
    result.permissionSource = permOverride !== undefined ? 'execution-profile' : 'playbook';
  }

  return result;
}

export function resolveLaunchOverrides(
  binding: RouteRoleBinding,
  nodeId: string,
  executionProfile: ExecutionProfile,
): LaunchOverrides | undefined {
  const overrides = executionProfile.bindingOverrides ?? [];
  const nodeMatches = overrides.filter((o) => o.match.nodeId === nodeId);

  if (nodeMatches.length === 0) {
    const hasAny =
      binding.resolvedModelLevel !== undefined ||
      binding.resolvedTimeoutMs !== undefined ||
      binding.resolvedPermissionMode !== undefined;
    if (!hasAny) return undefined;
    const lo: LaunchOverrides = {};
    if (binding.resolvedModelLevel && binding.modelSource === 'execution-profile') lo.modelLevel = binding.resolvedModelLevel;
    if (binding.resolvedTimeoutMs !== undefined && binding.timeoutSource === 'execution-profile') lo.timeoutMs = binding.resolvedTimeoutMs;
    if (binding.resolvedPermissionMode && binding.permissionSource === 'execution-profile') lo.permissionMode = binding.resolvedPermissionMode;
    return Object.keys(lo).length > 0 ? lo : undefined;
  }

  const nodeOverride = nodeMatches[0]!;
  const lo: LaunchOverrides = {};

  if (nodeOverride.runnerId) lo.runnerId = nodeOverride.runnerId;

  const modelLevel = nodeOverride.modelLevel ?? (binding.modelSource === 'execution-profile' ? binding.resolvedModelLevel : undefined);
  if (modelLevel) lo.modelLevel = modelLevel;

  const timeoutMs = nodeOverride.timeoutMs ?? (binding.timeoutSource === 'execution-profile' ? binding.resolvedTimeoutMs : undefined);
  if (timeoutMs !== undefined) lo.timeoutMs = timeoutMs;

  const permissionMode = nodeOverride.permissionMode ?? (binding.permissionSource === 'execution-profile' ? binding.resolvedPermissionMode : undefined);
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
