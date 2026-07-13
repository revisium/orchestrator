import { createHash } from 'node:crypto';
import type { ConsensusToggle, TopologyProfile } from '../pipeline-core/materialize.js';

type StageConfig = {
  mode?: string;
  branches?: number;
};

const HASHED_PROFILE_FIELDS = new Set(['pipelineId', 'schemaVersion', 'topology', 'bindings']);

export const PR_LIFECYCLE_NODES = [
  'confirmMerge',
  'integrator',
  'mergeApproveReverify',
  'mergeReadiness',
  'mergeRecheck',
  'overrideConfirmMerge',
  'overrideMerge',
  'pollPr',
  'questionReviewIntegrator',
  'respondThreads',
  'reviewIntegrator',
] as const;

type RunProfileContext = {
  pipelineId?: string;
  profileId?: string;
  schemaVersion?: string;
};

type RunProfileRevisionContext = {
  playbookId: string;
  pipelineId: string;
  profileId: string;
  schemaVersion: string;
  version: string;
  displayName: string;
  summary: string;
  status: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalRunProfilePayload(
  profile: Record<string, unknown>,
  context: RunProfileContext = {},
): Record<string, unknown> {
  const normalized = {
    ...profile,
    ...(context.pipelineId ? { pipelineId: context.pipelineId } : {}),
    ...(context.schemaVersion ? { schemaVersion: context.schemaVersion } : {}),
  };
  return Object.fromEntries(
    Object.entries(normalized).filter(([key, value]) => HASHED_PROFILE_FIELDS.has(key) && value !== undefined),
  );
}

export function runProfileHash(profile: Record<string, unknown>, context: RunProfileContext = {}): string {
  return createHash('sha256').update(stableStringify(canonicalRunProfilePayload(profile, context))).digest('hex');
}

export function runProfileRevisionHash(
  profile: Record<string, unknown>,
  context: RunProfileRevisionContext,
): string {
  return createHash('sha256').update(stableStringify({
    playbookId: context.playbookId,
    pipelineId: context.pipelineId,
    profileId: context.profileId,
    schemaVersion: context.schemaVersion,
    version: context.version,
    displayName: context.displayName,
    summary: context.summary,
    status: context.status,
    profileHash: runProfileHash(profile, {
      pipelineId: context.pipelineId,
      schemaVersion: context.schemaVersion,
    }),
  })).digest('hex');
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

export function topologyStageTargetsFromRunProfile(profile: Record<string, unknown>): string[] {
  return Object.keys(stageConfigs(profile));
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

export function topologyProfileFromRunProfile(
  profile: Record<string, unknown>,
  context: RunProfileContext = {},
): TopologyProfile {
  const profileId = context.profileId ?? stringValue(profile.id) ?? 'profile';
  const pipelineId = context.pipelineId ?? stringValue(profile.pipelineId) ?? '';
  const toggles: ConsensusToggle[] = [];
  for (const [target, stage] of Object.entries(stageConfigs(profile))) {
    if (stage.mode !== 'consensus') continue;
    toggles.push(consensusToggle(target, stage.branches ?? 2));
  }
  return { profileId, pipelineId, toggles };
}
