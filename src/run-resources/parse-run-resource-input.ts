import type {
  ParsedRunResourceInputV1,
  PipelineResourceDecl,
  PipelineWorkspacePolicy,
  RetentionPolicy,
  RunResourceBindings,
} from './types.js';

export type RunResourceDiagnosticCode =
  | 'RESOURCE_NAME_INVALID'
  | 'RESOURCE_REF_UNRESOLVED'
  | 'RESOURCE_BINDING_EXTRA'
  | 'RESOURCE_BINDING_MISSING'
  | 'RESOURCE_COUNT_UNSUPPORTED'
  | 'WORKSPACE_POLICY_INVALID'
  | 'SCRATCH_WITH_RESOURCES_INVALID';

export type RunResourceDiagnostic = {
  code: RunResourceDiagnosticCode;
  path: string;
  message: string;
};

export type RunResourceInputV1 = {
  resources?: unknown;
  workspace?: unknown;
  bindings?: unknown;
};

export type ParsedRunResourceInputResult =
  | { value: ParsedRunResourceInputV1; diagnostics: [] }
  | { value: null; diagnostics: RunResourceDiagnostic[] };

const resourceName = /^[a-z][a-z0-9-]{0,62}$/;
const retentionKeys = ['onSuccess', 'onFailure', 'onCancel', 'onBlocked'] as const;

function diagnostic(
  diagnostics: RunResourceDiagnostic[],
  code: RunResourceDiagnosticCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: RunResourceDiagnostic[],
  code: RunResourceDiagnosticCode,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) diagnostic(diagnostics, code, `${path}.${key}`, 'field is not supported in V1');
  }
}

function parseRetention(value: unknown, path: string, diagnostics: RunResourceDiagnostic[]): RetentionPolicy | null {
  if (!isRecord(value)) {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', path, 'retention must be an object');
    return null;
  }
  rejectUnknownKeys(value, retentionKeys, path, diagnostics, 'WORKSPACE_POLICY_INVALID');
  const result = {} as RetentionPolicy;
  for (const key of retentionKeys) {
    if (value[key] !== 'release' && value[key] !== 'retain') {
      diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', `${path}.${key}`, 'retention action is invalid');
    } else {
      result[key] = value[key];
    }
  }
  return diagnostics.some((item) => item.path.startsWith(path)) ? null : result;
}

function parseWorkspace(value: unknown, resources: Record<string, PipelineResourceDecl>, diagnostics: RunResourceDiagnostic[]): PipelineWorkspacePolicy | null {
  if (!isRecord(value) || !('isolation' in value)) {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', 'workspace', 'workspace policy is invalid');
    return null;
  }
  rejectUnknownKeys(value, ['isolation', 'resource', 'mutability', 'identity', 'retention'], 'workspace', diagnostics, 'WORKSPACE_POLICY_INVALID');
  const retention = parseRetention(value.retention, 'workspace.retention', diagnostics);
  if (value.isolation === 'scratch') {
    if (Object.keys(resources).length > 0) {
      diagnostic(diagnostics, 'SCRATCH_WITH_RESOURCES_INVALID', 'workspace.isolation', 'scratch cannot be used with resources');
    }
    return retention ? { isolation: 'scratch', retention } : null;
  }
  if (value.isolation !== 'resource' || typeof value.resource !== 'string' || !resourceName.test(value.resource)) {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', 'workspace', 'resource workspace policy is invalid');
    return null;
  }
  const declaration = resources[value.resource];
  if (!declaration || declaration.kind !== 'repository' || declaration.cardinality !== 'one' || declaration.required !== true) {
    diagnostic(diagnostics, 'RESOURCE_REF_UNRESOLVED', 'workspace.resource', 'workspace resource is not a required repository');
  }
  if (value.mutability !== 'read-only' && value.mutability !== 'mutable') {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', 'workspace.mutability', 'workspace mutability is invalid');
  }
  if (!isRecord(value.identity) || typeof value.identity.template !== 'string' || !/^(?:\{(?:runId|taskId|resource)\}|[^{}])*$/.test(value.identity.template)) {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', 'workspace.identity', 'workspace identity template is invalid');
  } else {
    rejectUnknownKeys(value.identity, ['template'], 'workspace.identity', diagnostics, 'WORKSPACE_POLICY_INVALID');
  }
  const mutability = value.mutability as 'read-only' | 'mutable';
  const identity = value.identity as { template: string };
  return retention && diagnostics.length === 0
    ? { isolation: 'resource', resource: value.resource, mutability, identity, retention }
    : null;
}

function containsSecret(value: unknown): boolean {
  if (typeof value !== 'string') {
    if (Array.isArray(value)) return value.some(containsSecret);
    if (isRecord(value)) return Object.entries(value).some(([key, entry]) => key !== 'credentialAliases' && /token|secret|session|cookie|private.?key|password|authorization|credential/i.test(key) || containsSecret(entry));
    return false;
  }
  return /^(Bearer\s|ssh-|-----BEGIN|gh[pousr]_)[^\s]+|https?:\/\/[^/]+:[^@]+@|^[A-Za-z0-9+/]{32,}={0,2}$/.test(value);
}

function parseBindings(value: unknown, resources: Record<string, PipelineResourceDecl>, diagnostics: RunResourceDiagnostic[]): RunResourceBindings {
  const bindings: RunResourceBindings = {};
  if (!isRecord(value)) {
    if (Object.keys(resources).length > 0) diagnostic(diagnostics, 'RESOURCE_BINDING_MISSING', 'bindings', 'bindings are required');
    return bindings;
  }
  for (const [name, binding] of Object.entries(value)) {
    if (!resources[name]) diagnostic(diagnostics, 'RESOURCE_BINDING_EXTRA', `bindings.${name}`, 'binding is undeclared');
    if (!isRecord(binding) || typeof binding.repositoryId !== 'string' || binding.repositoryId.trim() === '' || containsSecret(binding)) {
      diagnostic(diagnostics, 'RESOURCE_REF_UNRESOLVED', `bindings.${name}`, 'repository binding is invalid or credentialized');
      continue;
    }
    rejectUnknownKeys(binding, ['repositoryId', 'revision', 'credentialAliases'], `bindings.${name}`, diagnostics, 'RESOURCE_REF_UNRESOLVED');
    if (binding.revision !== undefined && typeof binding.revision !== 'string') {
      diagnostic(diagnostics, 'RESOURCE_REF_UNRESOLVED', `bindings.${name}.revision`, 'revision must be a string');
      continue;
    }
    if (binding.credentialAliases !== undefined && (!isRecord(binding.credentialAliases) || Object.keys(binding.credentialAliases).some((key) => key !== 'git' && key !== 'github') || Object.values(binding.credentialAliases as Record<string, unknown>).some((alias) => typeof alias !== 'string' || alias.trim() === ''))) {
      diagnostic(diagnostics, 'RESOURCE_REF_UNRESOLVED', `bindings.${name}.credentialAliases`, 'credential alias is invalid');
      continue;
    }
    bindings[name] = binding as RunResourceBindings[string];
  }
  for (const name of Object.keys(resources)) {
    if (!Object.hasOwn(bindings, name)) diagnostic(diagnostics, 'RESOURCE_BINDING_MISSING', `bindings.${name}`, 'binding is required');
  }
  return bindings;
}

export function parseRunResourceInputV1(input: unknown): ParsedRunResourceInputResult {
  const diagnostics: RunResourceDiagnostic[] = [];
  if (!isRecord(input)) {
    diagnostic(diagnostics, 'WORKSPACE_POLICY_INVALID', 'input', 'run resource input must be an object');
    return { value: null, diagnostics };
  }
  const rawResources = input.resources === undefined ? {} : input.resources;
  if (!isRecord(rawResources)) {
    diagnostic(diagnostics, 'RESOURCE_COUNT_UNSUPPORTED', 'resources', 'resources must be a record');
  }
  const resources: Record<string, PipelineResourceDecl> = {};
  if (isRecord(rawResources)) {
    const names = Object.keys(rawResources);
    if (names.length > 1) diagnostic(diagnostics, 'RESOURCE_COUNT_UNSUPPORTED', 'resources', 'only one repository resource is supported');
    for (const name of names) {
      const declaration = rawResources[name];
      if (!resourceName.test(name)) diagnostic(diagnostics, 'RESOURCE_NAME_INVALID', `resources.${name}`, 'resource name is invalid');
      if (!isRecord(declaration) || declaration.kind !== 'repository' || declaration.cardinality !== 'one' || typeof declaration.required !== 'boolean') {
        diagnostic(diagnostics, 'RESOURCE_COUNT_UNSUPPORTED', `resources.${name}`, 'resource declaration is unsupported');
      } else {
        rejectUnknownKeys(declaration, ['kind', 'cardinality', 'required'], `resources.${name}`, diagnostics, 'RESOURCE_COUNT_UNSUPPORTED');
        resources[name] = declaration as PipelineResourceDecl;
        if (declaration.required !== true) diagnostic(diagnostics, 'RESOURCE_COUNT_UNSUPPORTED', `resources.${name}.required`, 'optional resources are unsupported');
      }
    }
  }
  const workspace = parseWorkspace(input.workspace, resources, diagnostics);
  const bindings = parseBindings(input.bindings, resources, diagnostics);
  if (diagnostics.length > 0 || !workspace) return { value: null, diagnostics };
  return { value: { resources, workspace, bindings }, diagnostics: [] };
}
