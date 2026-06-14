export type ExecutionProfile = {
  id: string;
  runnerOverrides: Record<string, string>;
  availableRunners?: string[];
};

export type RouteRoleBinding = {
  roleId: string;
  rowId: string;
  modelLevel: string;
  runnerId: string;
  resolvedRunnerId: string;
  runnerSource: 'playbook' | 'execution-profile';
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

export function normalizeParams(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) return {};
  const {
    executionProfile: _executionProfile,
    execution_profile: _executionProfileSnake,
    runnerOverrides: _runnerOverrides,
    runner_overrides: _runnerOverridesSnake,
    availableRunners: _availableRunners,
    available_runners: _availableRunnersSnake,
    ...publicParams
  } = record;
  return publicParams;
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
  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : 'default',
    runnerOverrides: {
      ...asStringMap(raw.runnerOverrides),
      ...asStringMap(raw.runner_overrides),
    },
    availableRunners: asStringArray(raw.availableRunners) ?? asStringArray(raw.available_runners),
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
