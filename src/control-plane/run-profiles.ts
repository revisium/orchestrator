import type { BindingOverride, ExecutionProfile } from '../pipeline/route-contract.js';
import type { ConsensusToggle, TopologyProfile } from '../pipeline-core/materialize.js';

type StageConfig = {
  mode?: string;
  branches?: number;
};

type SlotBinding = {
  runnerId?: string;
  modelLevel?: string;
  timeoutMs?: number;
  permissionMode?: string;
};

const ROLE_SLOTS = new Set([
  'orchestrator',
  'analyst',
  'reviewer',
  'developer',
  'integrator',
  'watcher',
  'triager',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stageConfigs(profile: Record<string, unknown>): Record<string, StageConfig> {
  const topology = asRecord(profile.topology);
  const stages = asRecord(topology.stages);
  return Object.fromEntries(
    Object.entries(stages).map(([key, value]) => {
      const stage = asRecord(value);
      const branches = typeof stage.branches === 'number' && Number.isInteger(stage.branches) ? stage.branches : undefined;
      return [key, { mode: stringValue(stage.mode), ...(branches ? { branches } : {}) }];
    }),
  );
}

function consensusToggle(target: string, branches: number): ConsensusToggle {
  const baseName = target === 'planReviewer' ? 'planReview' : target;
  const mergeKey = target === 'planReviewer' ? 'planReview' : 'review';
  return {
    target,
    baseName,
    fanout: { branches },
    join: {
      joinMode: { kind: 'all' },
      verdictReducer: {
        kind: 'allIn',
        pass: ['approved', 'clean'],
        passVerdict: 'approved',
        failVerdict: 'changes_requested',
      },
      merge: { [mergeKey]: 'appendByBranchOrder' },
    },
  };
}

export function topologyProfileFromRunProfile(profile: Record<string, unknown>): TopologyProfile {
  const profileId = stringValue(profile.id) ?? 'profile';
  const pipelineId = stringValue(profile.pipelineId) ?? '';
  const toggles: ConsensusToggle[] = [];
  for (const [target, stage] of Object.entries(stageConfigs(profile))) {
    if (stage.mode !== 'consensus') continue;
    toggles.push(consensusToggle(target, stage.branches ?? 2));
  }
  return { profileId, pipelineId, toggles };
}

function slotMatch(slot: string): BindingOverride['match'] {
  if (slot.startsWith('role:')) return { roleId: slot.slice('role:'.length) };
  if (slot.startsWith('node:')) return { nodeId: slot.slice('node:'.length) };
  return ROLE_SLOTS.has(slot) ? { roleId: slot } : { nodeId: slot };
}

function bindingOverride(slot: string, binding: SlotBinding): BindingOverride | null {
  const override: BindingOverride = { match: slotMatch(slot) };
  if (binding.runnerId) override.runnerId = binding.runnerId;
  if (binding.modelLevel) override.modelLevel = binding.modelLevel;
  if (binding.timeoutMs !== undefined) override.timeoutMs = binding.timeoutMs;
  if (binding.permissionMode) override.permissionMode = binding.permissionMode;
  return Object.keys(override).length > 1 ? override : null;
}

export function executionProfileFromRunProfile(
  profile: Record<string, unknown>,
  callerProfile: ExecutionProfile,
): ExecutionProfile {
  const bindings = asRecord(profile.bindings);
  const slots = asRecord(bindings.slots);
  const profileOverrides = Object.entries(slots)
    .map(([slot, raw]) => bindingOverride(slot, asRecord(raw) as SlotBinding))
    .filter((override): override is BindingOverride => override !== null);
  return {
    ...callerProfile,
    runnerOverrides: { ...callerProfile.runnerOverrides },
    bindingOverrides: [
      ...profileOverrides,
      ...(callerProfile.bindingOverrides ?? []),
    ],
  };
}
