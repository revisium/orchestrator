import { createHash } from 'node:crypto';

export const PROFILE_SCHEMA_VERSION = 'run-profile/v1' as const;
export const EXECUTION_PLAN_SCHEMA_VERSION = 'execution-plan/v1' as const;

export type ProfileContractErrorCode =
  | 'profile_selector_invalid'
  | 'profile_not_found'
  | 'profile_not_launchable'
  | 'profile_schema_invalid'
  | 'profile_topology_unsupported'
  | 'profile_pipeline_mismatch'
  | 'profile_slot_unknown'
  | 'profile_binding_unresolved'
  | 'profile_script_binding_invalid'
  | 'model_config_invalid'
  | 'runner_manifest_unresolved'
  | 'runner_provider_mismatch'
  | 'runner_permission_invalid'
  | 'runner_permission_default_invalid'
  | 'execution_plan_invalid'
  | 'execution_plan_binding_unresolved';

export class RunProfileContractError extends Error {
  readonly name = 'RunProfileContractError';

  constructor(
    readonly code: ProfileContractErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

export type AgentBinding = {
  runnerId: string;
  provider: string;
  modelId: string;
  modelParams: Record<string, unknown>;
  permissionMode?: string;
  timeoutMs?: number;
};

export type ScriptBinding = {
  accounts: Record<string, string>;
};

export type RunProfile = {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  topology: {
    stages: Record<string, { mode: 'single' | 'consensus'; branches?: number }>;
  };
  bindings: {
    slots: Record<string, AgentBinding | ScriptBinding>;
  };
};

export type RunnerManifestConstraints = {
  allowedProviders?: string[];
  permissionModes?: string[];
  modelParamKeys?: string[];
};

export type RunnerManifest = {
  runnerId: string;
  manifestVersion: string;
  manifestDigest: string;
  stdoutParserId: string;
  permissionStyleId: string;
  declaredDefaultPermissionMode: string;
  capabilities: Record<string, unknown>;
  constraints: RunnerManifestConstraints;
  executionFields: Record<string, unknown>;
};

export type PinnedRunnerManifest = RunnerManifest;

export type RunnerManifestSnapshot = Omit<RunnerManifest, 'manifestDigest'>;

export type GraphAgentNode = {
  id: string;
  kind: 'agent';
  roleRef: string;
};

export type GraphScriptNode = {
  id: string;
  kind: 'script';
  scriptRef: string;
};

export type GraphExecutableNode = GraphAgentNode | GraphScriptNode;

export type RoleDocument = {
  roleDocumentId: string;
};

export type ResolvedAgentBinding = AgentBinding & {
  slotKey: string;
  nodeId: string;
  roleId: string;
  roleDocumentId: string;
  runner: PinnedRunnerManifest;
  permissionMode: string;
  permissionSource: 'profile' | 'runner-manifest-default';
};

export type ResolvedScriptBinding = {
  nodeId: string;
  scriptRef: string;
  accountAliases: Record<string, string>;
};

export type GraphBindingResolution = {
  agentBindings: ResolvedAgentBinding[];
  scriptBindings: ResolvedScriptBinding[];
};

export type ExecutionPlanSelection = {
  playbookId: string;
  pipelineId: string;
  pipelineRowId: string;
  source: 'explicit';
  requestedPipelineId?: string;
  basePipelineId?: string;
};

export type ExecutionPlan = {
  schemaVersion: typeof EXECUTION_PLAN_SCHEMA_VERSION;
  executionPlanId: string;
  executionPlanDigest: string;
  selection: ExecutionPlanSelection;
  businessParams: Record<string, unknown>;
  profile: {
    source: 'stored' | 'inline';
    profileId?: string;
    profileVersion?: string;
    profileHash: string;
  };
  pipeline: {
    executableGraph: unknown;
    graphDigest: string;
    materializerVersion: string;
    policyVersion: string;
    routeGates: string[];
    executionPolicy: unknown;
  };
  agentBindings: ResolvedAgentBinding[];
  scriptBindings: ResolvedScriptBinding[];
};

export type CompiledExecutionPlan = {
  plan: ExecutionPlan;
  bytes: string;
  digest: string;
};

export type ProfileSelectorInput = {
  profileId?: unknown;
  profile?: unknown;
};

export type ProfileSelection =
  | { source: 'stored'; profileId: string }
  | { source: 'inline'; profile: unknown };

export type StoredProfileSource = {
  profile: unknown;
  profileId?: string;
  profileVersion?: string;
  profileHash?: string;
  pipelineId?: string;
  schemaVersion?: string;
  status?: 'active' | 'deprecated' | 'removed';
};

export type ResolvedProfileSource = {
  source: 'stored' | 'inline';
  profile: RunProfile;
  profileId?: string;
  profileVersion?: string;
  profileHash?: string;
  pipelineId?: string;
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(code: ProfileContractErrorCode, path: string, message: string): never {
  throw new RunProfileContractError(code, `${message} at ${path}`, path);
}

function nonEmptyString(value: unknown, path: string, code: ProfileContractErrorCode = 'profile_schema_invalid'): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  fail(code, path, 'must be a non-empty string');
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string, code: ProfileContractErrorCode): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${path}.${key}`, 'unknown field');
  }
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function jsonValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]));
  }
  fail('model_config_invalid', path, 'must contain JSON values');
}

function jsonObject(
  value: unknown,
  path: string,
  errorCode: ProfileContractErrorCode = 'model_config_invalid',
): Record<string, unknown> {
  if (!isRecord(value)) fail(errorCode, path, 'must be an object');
  return jsonValue(value, path) as Record<string, unknown>;
}

function secretFree(value: unknown, path: string, errorCode: ProfileContractErrorCode = 'model_config_invalid'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretFree(item, `${path}[${index}]`, errorCode));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (/(secret|token|password|api[_-]?key|private[_-]?key)/i.test(key)) {
      fail(errorCode, `${path}.${key}`, 'must not contain secret-bearing fields');
    }
    secretFree(item, `${path}.${key}`, errorCode);
  }
}

function normalizeAgentBinding(value: Record<string, unknown>, path: string): AgentBinding {
  exactKeys(value, ['runnerId', 'provider', 'modelId', 'modelParams', 'permissionMode', 'timeoutMs'], path, 'profile_schema_invalid');
  const runnerId = nonEmptyString(value.runnerId, `${path}.runnerId`);
  const provider = nonEmptyString(value.provider, `${path}.provider`);
  const modelId = nonEmptyString(value.modelId, `${path}.modelId`);
  const modelParams = jsonObject(value.modelParams, `${path}.modelParams`);
  secretFree(modelParams, `${path}.modelParams`);
  const permissionMode = value.permissionMode === undefined
    ? undefined
    : nonEmptyString(value.permissionMode, `${path}.permissionMode`);
  const timeoutMs: unknown = value.timeoutMs;
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 86_400_000)) {
    fail('profile_schema_invalid', `${path}.timeoutMs`, 'must be a positive integer no greater than 86400000');
  }
  return {
    runnerId,
    provider,
    modelId,
    modelParams,
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function normalizeScriptBinding(value: Record<string, unknown>, path: string): ScriptBinding {
  if (Object.keys(value).some((key) => key !== 'accounts')) {
    const agentField = Object.keys(value).find((key) => key !== 'accounts') ?? 'binding';
    fail('profile_script_binding_invalid', `${path}.${agentField}`, 'script bindings may contain accounts only');
  }
  if (!isRecord(value.accounts) || Object.keys(value.accounts).length === 0) {
    fail('profile_script_binding_invalid', `${path}.accounts`, 'must contain at least one account alias');
  }
  const accounts: Record<string, string> = {};
  for (const [key, account] of Object.entries(value.accounts)) {
    accounts[nonEmptyString(key, `${path}.accounts`)] = nonEmptyString(account, `${path}.accounts.${key}`, 'profile_script_binding_invalid');
  }
  return { accounts };
}

function normalizeStage(value: unknown, path: string): { mode: 'single' | 'consensus'; branches?: number } {
  if (!isRecord(value)) fail('profile_schema_invalid', path, 'must be an object');
  exactKeys(value, ['mode', 'branches'], path, 'profile_schema_invalid');
  if (value.mode !== 'single' && value.mode !== 'consensus') fail('profile_schema_invalid', `${path}.mode`, 'must be single or consensus');
  if (value.mode === 'single') {
    if (value.branches !== undefined) fail('profile_schema_invalid', `${path}.branches`, 'is not allowed for single stages');
    return { mode: 'single' };
  }
  if (!Number.isSafeInteger(value.branches) || (value.branches as number) < 2 || (value.branches as number) > 8) {
    fail('profile_schema_invalid', `${path}.branches`, 'must be an integer between 2 and 8');
  }
  return { mode: 'consensus', branches: value.branches as number };
}

export function validateRunProfile(value: unknown): RunProfile {
  if (!isRecord(value)) fail('profile_schema_invalid', '/', 'profile must be an object');
  exactKeys(value, ['schemaVersion', 'topology', 'bindings'], '/', 'profile_schema_invalid');
  if (value.schemaVersion !== PROFILE_SCHEMA_VERSION) fail('profile_schema_invalid', '/schemaVersion', `must equal ${PROFILE_SCHEMA_VERSION}`);

  if (!isRecord(value.topology)) fail('profile_schema_invalid', '/topology', 'must be an object');
  exactKeys(value.topology, ['stages'], '/topology', 'profile_schema_invalid');
  if (!isRecord(value.topology.stages)) fail('profile_schema_invalid', '/topology/stages', 'must be an object');
  const stages: RunProfile['topology']['stages'] = {};
  for (const [stageId, stage] of Object.entries(value.topology.stages)) {
    stages[nonEmptyString(stageId, '/topology/stages')] = normalizeStage(stage, `/topology/stages.${stageId}`);
  }

  if (!isRecord(value.bindings)) fail('profile_schema_invalid', '/bindings', 'must be an object');
  exactKeys(value.bindings, ['slots'], '/bindings', 'profile_schema_invalid');
  if (!isRecord(value.bindings.slots)) fail('profile_schema_invalid', '/bindings/slots', 'must be an object');
  const slots: RunProfile['bindings']['slots'] = {};
  for (const [slot, rawBinding] of Object.entries(value.bindings.slots)) {
    if (!/^(role|node):[^\s:]+$/.test(slot)) fail('profile_schema_invalid', `/bindings/slots.${slot}`, 'must use a canonical role:<id> or node:<id> key');
    if (!isRecord(rawBinding)) fail('profile_schema_invalid', `/bindings/slots.${slot}`, 'must be an object');
    const binding = rawBinding.accounts !== undefined
      ? normalizeScriptBinding(rawBinding, `/bindings/slots.${slot}`)
      : normalizeAgentBinding(rawBinding, `/bindings/slots.${slot}`);
    slots[slot] = binding;
  }

  return { schemaVersion: PROFILE_SCHEMA_VERSION, topology: { stages }, bindings: { slots } };
}

export function selectRunProfile(input: ProfileSelectorInput): ProfileSelection {
  const hasProfileId = input.profileId !== undefined;
  const hasInlineProfile = input.profile !== undefined;
  if (hasProfileId === hasInlineProfile) fail('profile_selector_invalid', '/', 'exactly one of profileId or profile is required');
  if (hasProfileId) return { source: 'stored', profileId: nonEmptyString(input.profileId, '/profileId', 'profile_selector_invalid') };
  if (input.profile === null || input.profile === undefined) fail('profile_selector_invalid', '/profile', 'inline profile must be an object');
  return { source: 'inline', profile: input.profile };
}

export async function resolveProfileSource(
  input: ProfileSelectorInput,
  loadStored: (profileId: string) => Promise<StoredProfileSource>,
): Promise<ResolvedProfileSource> {
  const selection = selectRunProfile(input);
  if (selection.source === 'inline') {
    return { source: 'inline', profile: validateRunProfile(selection.profile), schemaVersion: PROFILE_SCHEMA_VERSION };
  }
  const stored = await loadStored(selection.profileId);
  if (stored.status !== undefined && stored.status !== 'active') {
    fail('profile_not_launchable', '/status', `stored run profile ${selection.profileId} is ${stored.status}`);
  }
  if (stored.schemaVersion !== undefined && stored.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    fail('profile_schema_invalid', '/schemaVersion', `must equal ${PROFILE_SCHEMA_VERSION}`);
  }
  const profile = validateRunProfile(stored.profile);
  return {
    source: 'stored',
    profile,
    profileId: stored.profileId ?? selection.profileId,
    ...(stored.profileVersion ? { profileVersion: stored.profileVersion } : {}),
    ...(stored.profileHash ? { profileHash: stored.profileHash } : {}),
    ...(stored.pipelineId ? { pipelineId: stored.pipelineId } : {}),
    schemaVersion: PROFILE_SCHEMA_VERSION,
  };
}

function manifestMap(value: Record<string, RunnerManifest> | Map<string, RunnerManifest>): Map<string, RunnerManifest> {
  return value instanceof Map ? value : new Map(Object.entries(value));
}

function manifestSnapshot(manifest: RunnerManifest): RunnerManifestSnapshot {
  return {
    runnerId: manifest.runnerId,
    manifestVersion: manifest.manifestVersion,
    stdoutParserId: manifest.stdoutParserId,
    permissionStyleId: manifest.permissionStyleId,
    declaredDefaultPermissionMode: manifest.declaredDefaultPermissionMode,
    capabilities: manifest.capabilities,
    constraints: manifest.constraints,
    executionFields: manifest.executionFields,
  };
}

export function canonicalRunnerManifestSnapshot(manifest: RunnerManifest): RunnerManifestSnapshot {
  return manifestSnapshot(manifest);
}

export function canonicalRunnerManifestBytes(manifest: RunnerManifest): string {
  return stableStringify(manifestSnapshot(manifest));
}

export function runnerManifestDigest(manifest: RunnerManifest): string {
  return `sha256:${createHash('sha256').update(canonicalRunnerManifestBytes(manifest)).digest('hex')}`;
}

function normalizeManifest(
  manifest: RunnerManifest,
  path: string,
  errorCode: ProfileContractErrorCode = 'runner_manifest_unresolved',
): PinnedRunnerManifest {
  if (!isRecord(manifest)) fail(errorCode, path, 'must be an object');
  exactKeys(manifest, [
    'runnerId',
    'manifestVersion',
    'manifestDigest',
    'stdoutParserId',
    'permissionStyleId',
    'declaredDefaultPermissionMode',
    'capabilities',
    'constraints',
    'executionFields',
  ], path, errorCode);
  const fields: Array<keyof RunnerManifest> = [
    'runnerId',
    'manifestVersion',
    'manifestDigest',
    'stdoutParserId',
    'permissionStyleId',
    'declaredDefaultPermissionMode',
  ];
  for (const field of fields) nonEmptyString(manifest[field], `${path}.${field}`, errorCode);
  if (!isRecord(manifest.capabilities)) fail(errorCode, `${path}.capabilities`, 'must be an object');
  if (!isRecord(manifest.constraints)) fail(errorCode, `${path}.constraints`, 'must be an object');
  if (!isRecord(manifest.executionFields)) fail(errorCode, `${path}.executionFields`, 'must be an object');
  exactKeys(manifest.constraints, ['allowedProviders', 'permissionModes', 'modelParamKeys'], `${path}.constraints`, errorCode);
  const constraints: RunnerManifestConstraints = {};
  for (const field of ['allowedProviders', 'permissionModes', 'modelParamKeys'] as const) {
    const list = manifest.constraints[field];
    if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim() === ''))) {
      fail(errorCode, `${path}.constraints.${field}`, 'must be a non-empty string array when present');
    }
    if (list !== undefined) constraints[field] = [...list].map((item) => item.trim());
  }
  const normalized: PinnedRunnerManifest = {
    runnerId: manifest.runnerId.trim(),
    manifestVersion: manifest.manifestVersion.trim(),
    manifestDigest: manifest.manifestDigest.trim(),
    stdoutParserId: manifest.stdoutParserId.trim(),
    permissionStyleId: manifest.permissionStyleId.trim(),
    declaredDefaultPermissionMode: manifest.declaredDefaultPermissionMode.trim(),
    capabilities: jsonObject(manifest.capabilities, `${path}.capabilities`, errorCode),
    constraints,
    executionFields: jsonObject(manifest.executionFields, `${path}.executionFields`, errorCode),
  };
  secretFree(normalized.executionFields, `${path}.executionFields`, errorCode);
  if (!SHA256_DIGEST.test(normalized.manifestDigest)) {
    fail(errorCode, `${path}.manifestDigest`, 'must be a lowercase sha256 digest');
  }
  if (runnerManifestDigest(normalized) !== normalized.manifestDigest) {
    fail(errorCode, `${path}.manifestDigest`, 'does not match the canonical execution snapshot');
  }
  return normalized;
}

function resolveAgentBinding(
  binding: AgentBinding,
  node: GraphAgentNode,
  slotKey: string,
  roleDocument: RoleDocument | undefined,
  manifests: Map<string, RunnerManifest>,
): ResolvedAgentBinding {
  if (!roleDocument) fail('profile_binding_unresolved', `role:${node.roleRef.replace(/^role:/, '')}`, `role document for ${node.roleRef} is missing`);
  const rawManifest = manifests.get(binding.runnerId);
  if (!rawManifest) fail('runner_manifest_unresolved', `${slotKey}.runnerId`, `runner manifest ${binding.runnerId} is not registered`);
  const runner = normalizeManifest(rawManifest, `runnerManifests.${binding.runnerId}`);
  if (runner.runnerId !== binding.runnerId) fail('runner_manifest_unresolved', `${slotKey}.runnerId`, 'manifest identity does not match runnerId');
  const allowedProviders = runner.constraints.allowedProviders;
  if (allowedProviders && allowedProviders.length > 0 && !allowedProviders.includes(binding.provider)) {
    fail('runner_provider_mismatch', `${slotKey}.provider`, `provider ${binding.provider} is not accepted by runner ${binding.runnerId}`);
  }
  const permissionModes = runner.constraints.permissionModes;
  if (!runner.declaredDefaultPermissionMode || (permissionModes && !permissionModes.includes(runner.declaredDefaultPermissionMode))) {
    fail('runner_permission_default_invalid', `${slotKey}.runnerId`, `runner ${binding.runnerId} has no valid declared default permission mode`);
  }
  const permissionMode = binding.permissionMode ?? runner.declaredDefaultPermissionMode;
  if (permissionModes && !permissionModes.includes(permissionMode)) {
    fail('runner_permission_invalid', `${slotKey}.permissionMode`, `permission mode ${permissionMode} is not accepted by runner ${binding.runnerId}`);
  }
  const modelParamKeys = runner.constraints.modelParamKeys;
  if (modelParamKeys && Object.keys(binding.modelParams).some((key) => !modelParamKeys.includes(key))) {
    fail('model_config_invalid', `${slotKey}.modelParams`, `contains a parameter not accepted by runner ${binding.runnerId}`);
  }
  return {
    ...binding,
    slotKey,
    nodeId: node.id,
    roleId: node.roleRef.replace(/^role:/, ''),
    roleDocumentId: roleDocument.roleDocumentId,
    runner,
    permissionMode,
    permissionSource: binding.permissionMode === undefined ? 'runner-manifest-default' : 'profile',
  };
}

export function resolveGraphBindings(
  profile: RunProfile,
  input: {
    nodes: GraphExecutableNode[];
    roleDocuments: Record<string, RoleDocument>;
    runnerManifests: Record<string, RunnerManifest> | Map<string, RunnerManifest>;
  },
): GraphBindingResolution {
  const manifests = manifestMap(input.runnerManifests);
  const nodesById = new Map(input.nodes.map((node) => [node.id, node]));
  const slots = profile.bindings.slots;
  const consumed = new Set<string>();
  for (const [slot, binding] of Object.entries(slots)) {
    const target = slot.slice(slot.indexOf(':') + 1);
    const node = slot.startsWith('node:') ? nodesById.get(target) : undefined;
    if (slot.startsWith('node:') && (!node || (node.kind !== 'agent' && node.kind !== 'script'))) {
      fail('profile_slot_unknown', `/bindings/slots.${slot}`, 'does not identify an executable graph node');
    }
    if (slot.startsWith('role:') && !input.nodes.some((candidate) => candidate.kind === 'agent' && candidate.roleRef === slot)) {
      fail('profile_slot_unknown', `/bindings/slots.${slot}`, 'does not identify an executable agent role');
    }
    if (slot.startsWith('role:') && 'accounts' in binding) {
      fail('profile_script_binding_invalid', `/bindings/slots.${slot}`, 'account bindings are valid only for script node slots');
    }
    if (node?.kind === 'agent' && 'accounts' in binding) {
      fail('profile_script_binding_invalid', `/bindings/slots.${slot}`, 'account bindings are only valid for script nodes');
    }
    if (slot.startsWith('node:') && node?.kind === 'script' && !('accounts' in binding)) {
      fail('profile_script_binding_invalid', `/bindings/slots.${slot}`, 'script bindings may contain accounts only');
    }
  }

  const agentBindings: ResolvedAgentBinding[] = [];
  const scriptBindings: ResolvedScriptBinding[] = [];
  for (const node of input.nodes) {
    const nodeSlot = `node:${node.id}`;
    const roleSlot = node.kind === 'agent' ? node.roleRef : undefined;
    const slotKey = slots[nodeSlot] !== undefined ? nodeSlot : roleSlot;
    if (slotKey === undefined || slots[slotKey] === undefined) {
      fail('profile_binding_unresolved', `/bindings/slots.${nodeSlot}`, `no binding for executable node ${node.id}`);
    }
    const binding = slots[slotKey];
    consumed.add(slotKey);
    if (node.kind === 'agent' && roleSlot !== undefined && slotKey === nodeSlot && slots[roleSlot] !== undefined) {
      consumed.add(roleSlot);
    }
    if (node.kind === 'agent') {
      if (!('runnerId' in binding)) fail('profile_binding_unresolved', `/bindings/slots.${slotKey}`, `agent node ${node.id} has no agent binding`);
      const roleId = node.roleRef.replace(/^role:/, '');
      agentBindings.push(resolveAgentBinding(binding, node, slotKey, input.roleDocuments[roleId], manifests));
    } else {
      if (!('accounts' in binding)) fail('profile_script_binding_invalid', `/bindings/slots.${slotKey}`, `script node ${node.id} requires an account binding`);
      scriptBindings.push({ nodeId: node.id, scriptRef: node.scriptRef, accountAliases: { ...binding.accounts } });
    }
  }
  for (const slot of Object.keys(slots)) {
    if (!consumed.has(slot)) fail('profile_slot_unknown', `/bindings/slots.${slot}`, 'does not identify a materialized executable obligation');
  }
  agentBindings.sort((left, right) => codeUnitCompare(left.nodeId, right.nodeId));
  scriptBindings.sort((left, right) => codeUnitCompare(left.nodeId, right.nodeId));
  return { agentBindings, scriptBindings };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(codeUnitCompare)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

function validatePinnedAgentBinding(
  binding: unknown,
  path: string,
  errorCode: ProfileContractErrorCode,
): void {
  if (!isRecord(binding) || !isRecord(binding.runner) || !isRecord(binding.modelParams)) {
    fail(errorCode, path, 'resolved agent binding is incomplete');
  }
  exactKeys(binding, [
    'runnerId',
    'provider',
    'modelId',
    'modelParams',
    'permissionMode',
    'timeoutMs',
    'slotKey',
    'nodeId',
    'roleId',
    'roleDocumentId',
    'runner',
    'permissionSource',
  ], path, errorCode);
  const runnerId = nonEmptyString(binding.runnerId, `${path}.runnerId`, errorCode);
  nonEmptyString(binding.provider, `${path}.provider`, errorCode);
  nonEmptyString(binding.modelId, `${path}.modelId`, errorCode);
  const slotKey = nonEmptyString(binding.slotKey, `${path}.slotKey`, errorCode);
  const nodeId = nonEmptyString(binding.nodeId, `${path}.nodeId`, errorCode);
  const roleId = nonEmptyString(binding.roleId, `${path}.roleId`, errorCode);
  nonEmptyString(binding.roleDocumentId, `${path}.roleDocumentId`, errorCode);
  if (!/^(role|node):[^\s:]+$/.test(slotKey)) {
    fail(errorCode, `${path}.slotKey`, 'must use a canonical role:<id> or node:<id> key');
  }
  const slotTarget = slotKey.slice(slotKey.indexOf(':') + 1);
  if ((slotKey.startsWith('node:') && slotTarget !== nodeId) ||
    (slotKey.startsWith('role:') && slotTarget !== roleId)) {
    fail(errorCode, `${path}.slotKey`, 'does not match the pinned binding identity');
  }
  const modelParams = binding.modelParams;
  secretFree(modelParams, `${path}.modelParams`, errorCode);
  const manifest = normalizeManifest(binding.runner as unknown as RunnerManifest, `${path}.runner`, errorCode);
  if (manifest.runnerId !== runnerId) fail(errorCode, `${path}.runner.runnerId`, 'must match binding.runnerId');
  if (manifest.constraints.allowedProviders && manifest.constraints.allowedProviders.length > 0 &&
    !manifest.constraints.allowedProviders.includes(String(binding.provider))) {
    fail(errorCode, `${path}.provider`, 'is not accepted by the pinned runner manifest');
  }
  const permissionModes = manifest.constraints.permissionModes;
  if (!manifest.declaredDefaultPermissionMode || (permissionModes && !permissionModes.includes(manifest.declaredDefaultPermissionMode))) {
    fail(errorCode, `${path}.runner.declaredDefaultPermissionMode`, 'is not a valid pinned runner default');
  }
  const permissionMode = nonEmptyString(binding.permissionMode, `${path}.permissionMode`, errorCode);
  if (permissionModes && !permissionModes.includes(permissionMode)) {
    fail(errorCode, `${path}.permissionMode`, 'is not accepted by the pinned runner manifest');
  }
  if (binding.permissionSource !== 'profile' && binding.permissionSource !== 'runner-manifest-default') {
    fail(errorCode, `${path}.permissionSource`, 'must identify the source of the effective permission mode');
  }
  if (binding.permissionSource === 'runner-manifest-default' && permissionMode !== manifest.declaredDefaultPermissionMode) {
    fail(errorCode, `${path}.permissionMode`, 'must equal the pinned runner default when source is runner-manifest-default');
  }
  const modelParamKeys = manifest.constraints.modelParamKeys;
  if (modelParamKeys && Object.keys(modelParams).some((key) => !modelParamKeys.includes(key))) {
    fail(errorCode, `${path}.modelParams`, 'contains a parameter not accepted by the pinned runner manifest');
  }
  if (binding.timeoutMs !== undefined &&
    (typeof binding.timeoutMs !== 'number' || !Number.isSafeInteger(binding.timeoutMs) || binding.timeoutMs <= 0 || binding.timeoutMs > 86_400_000)) {
    fail(errorCode, `${path}.timeoutMs`, 'must be a positive integer no greater than 86400000');
  }
}

function planUnsigned(plan: Omit<ExecutionPlan, 'executionPlanId' | 'executionPlanDigest'>): Omit<ExecutionPlan, 'executionPlanId' | 'executionPlanDigest'> {
  return plan;
}

export function compileExecutionPlan(input: Omit<ExecutionPlan, 'schemaVersion' | 'executionPlanId' | 'executionPlanDigest'>): CompiledExecutionPlan {
  if (!isRecord(input.businessParams)) {
    throw new RunProfileContractError('execution_plan_invalid', '/businessParams', 'businessParams must be an object');
  }
  const businessParams = jsonObject(input.businessParams, '/businessParams', 'execution_plan_invalid');
  const base = {
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    selection: input.selection,
    businessParams,
    profile: input.profile,
    pipeline: input.pipeline,
    agentBindings: input.agentBindings,
    scriptBindings: input.scriptBindings,
  } satisfies Omit<ExecutionPlan, 'executionPlanId' | 'executionPlanDigest'>;
  if (!Array.isArray(base.agentBindings) || !Array.isArray(base.scriptBindings)) {
    throw new RunProfileContractError('execution_plan_binding_unresolved', '/agentBindings', 'plan bindings must be arrays');
  }
  for (const binding of base.agentBindings) {
    validatePinnedAgentBinding(binding, `/agentBindings[${base.agentBindings.indexOf(binding)}]`, 'execution_plan_binding_unresolved');
  }
  for (const binding of base.scriptBindings) {
    if (!binding.nodeId || !binding.scriptRef || !isRecord(binding.accountAliases) ||
      Object.values(binding.accountAliases).some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw new RunProfileContractError('execution_plan_binding_unresolved', '/scriptBindings', 'resolved script binding is incomplete');
    }
  }
  const planDigest = digest(planUnsigned(base));
  const executionPlanId = `execution-plan:${planDigest.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  const plan: ExecutionPlan = {
    ...base,
    executionPlanId,
    executionPlanDigest: planDigest,
  };
  return { plan, bytes: stableStringify(plan), digest: planDigest };
}

export function parseExecutionPlan(bytes: string, expectedDigest?: string): ExecutionPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes) as unknown;
  } catch {
    throw new RunProfileContractError('execution_plan_invalid', '/', 'plan bytes are not valid JSON');
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== EXECUTION_PLAN_SCHEMA_VERSION || typeof parsed.executionPlanDigest !== 'string' ||
    typeof parsed.executionPlanId !== 'string' || parsed.executionPlanId.trim() === '') {
    throw new RunProfileContractError('execution_plan_invalid', '/', 'plan shape is invalid');
  }
  if (!SHA256_DIGEST.test(parsed.executionPlanDigest)) {
    throw new RunProfileContractError('execution_plan_invalid', '/executionPlanDigest', 'plan digest must be a lowercase sha256 digest');
  }
  const rootKeys = ['schemaVersion', 'executionPlanId', 'executionPlanDigest', 'selection', 'businessParams', 'profile', 'pipeline', 'agentBindings', 'scriptBindings'];
  if (Object.keys(parsed).some((key) => !rootKeys.includes(key))) {
    throw new RunProfileContractError('execution_plan_invalid', '/', 'plan contains an unknown field');
  }
  if (!isRecord(parsed.businessParams) || !isRecord(parsed.selection) || !isRecord(parsed.profile) || !isRecord(parsed.pipeline) ||
    !Array.isArray(parsed.agentBindings) || !Array.isArray(parsed.scriptBindings)) {
    throw new RunProfileContractError('execution_plan_invalid', '/', 'plan shape is invalid');
  }
  for (const [index, binding] of parsed.agentBindings.entries()) {
    try {
      validatePinnedAgentBinding(binding, `/agentBindings[${index}]`, 'execution_plan_invalid');
    } catch (error) {
      if (error instanceof RunProfileContractError) throw error;
      throw new RunProfileContractError('execution_plan_invalid', `/agentBindings[${index}]`, 'plan contains an invalid agent binding');
    }
  }
  if (parsed.scriptBindings.some((binding) => !isRecord(binding) || typeof binding.nodeId !== 'string' ||
    typeof binding.scriptRef !== 'string' || !isRecord(binding.accountAliases))) {
    throw new RunProfileContractError('execution_plan_binding_unresolved', '/scriptBindings', 'plan contains an incomplete script binding');
  }
  const { executionPlanId: _id, executionPlanDigest: actual, ...unsigned } = parsed;
  const recomputed = digest(unsigned);
  const expectedPlanId = `execution-plan:${recomputed.slice('sha256:'.length, 'sha256:'.length + 24)}`;
  if (parsed.executionPlanId !== expectedPlanId) {
    throw new RunProfileContractError('execution_plan_invalid', '/executionPlanId', 'plan id is not canonical for plan bytes');
  }
  if (actual !== recomputed || (expectedDigest !== undefined && expectedDigest !== actual)) {
    throw new RunProfileContractError('execution_plan_invalid', '/executionPlanDigest', 'plan digest does not match plan bytes');
  }
  return parsed as unknown as ExecutionPlan;
}
