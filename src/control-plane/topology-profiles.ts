import type { BindingOverride } from '../pipeline/route-contract.js';
import type { TopologyProfile } from '../pipeline-core/materialize.js';

const FEATURE_DEVELOPMENT_PIPELINE_ID = 'feature-development';

export const CONSENSUS_TOGGLE_ALLOWLIST: Record<string, string[]> = {
  [FEATURE_DEVELOPMENT_PIPELINE_ID]: ['planReviewer', 'codeReview'],
};

const REVIEW_CONSENSUS_TOGGLES: TopologyProfile['toggles'] = [
  {
    target: 'planReviewer',
    baseName: 'planReview',
    fanout: { branches: 2 },
    join: {
      joinMode: { kind: 'all' },
      verdictReducer: {
        kind: 'allIn',
        pass: ['approved', 'clean'],
        passVerdict: 'approved',
        failVerdict: 'changes_requested',
      },
      merge: { planReview: 'appendByBranchOrder' },
    },
  },
  {
    target: 'codeReview',
    baseName: 'codeReview',
    fanout: { branches: 2 },
    join: {
      joinMode: { kind: 'all' },
      verdictReducer: {
        kind: 'allIn',
        pass: ['approved', 'clean'],
        passVerdict: 'approved',
        failVerdict: 'changes_requested',
      },
      merge: { review: 'appendByBranchOrder' },
    },
  },
];

const EMPTY_TOPOLOGY: TopologyProfile['toggles'] = [];

export const CLAUDE_STANDARD_PROFILE: TopologyProfile = {
  profileId: 'claude-standard',
  pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
  toggles: EMPTY_TOPOLOGY,
};

export const CODEX_STANDARD_PROFILE: TopologyProfile = {
  profileId: 'codex-standard',
  pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
  toggles: EMPTY_TOPOLOGY,
};

export const CODEX_CONSENSUS_PROFILE: TopologyProfile = {
  profileId: 'codex-consensus',
  pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
  toggles: REVIEW_CONSENSUS_TOGGLES,
};

export const CODEX_CLAUDE_REVIEW_CONSENSUS_PROFILE: TopologyProfile = {
  profileId: 'codex-claude-review-consensus',
  pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
  toggles: REVIEW_CONSENSUS_TOGGLES,
};

export const CLAUDE_CODEX_REVIEW_CONSENSUS_PROFILE: TopologyProfile = {
  profileId: 'claude-codex-review-consensus',
  pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
  toggles: REVIEW_CONSENSUS_TOGGLES,
};

export const CODEX_CONSENSUS_PROFILE_VERSION = '1';
export const FEATURE_DEVELOPMENT_PROFILE_VERSION = '1';

export type ProfileBindings = {
  runnerOverrides: Record<string, string>;
  bindingOverrides: BindingOverride[];
};

export const CLAUDE_STANDARD_BINDINGS: ProfileBindings = {
  runnerOverrides: {},
  bindingOverrides: [
    { match: { roleId: 'orchestrator' }, modelLevel: 'standard' },
    { match: { roleId: 'analyst' }, modelLevel: 'deep' },
    { match: { roleId: 'reviewer' }, modelLevel: 'deep' },
    { match: { roleId: 'triager' }, modelLevel: 'standard' },
    { match: { roleId: 'developer' }, modelLevel: 'standard' },
    { match: { roleId: 'watcher' }, modelLevel: 'standard' },
  ],
};

export const CODEX_STANDARD_BINDINGS: ProfileBindings = {
  runnerOverrides: { 'claude-code': 'codex' },
  bindingOverrides: [
    { match: { roleId: 'orchestrator' }, modelLevel: 'codex-standard' },
    { match: { roleId: 'analyst' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'reviewer' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'triager' }, modelLevel: 'codex-standard' },
    { match: { roleId: 'developer' }, modelLevel: 'codex-standard' },
    { match: { roleId: 'watcher' }, modelLevel: 'codex-standard' },
  ],
};

export const CODEX_CONSENSUS_BINDINGS: ProfileBindings = {
  runnerOverrides: { 'claude-code': 'codex' },
  bindingOverrides: [
    { match: { roleId: 'orchestrator' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'analyst' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'reviewer' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'triager' }, modelLevel: 'codex-deep' },
    { match: { roleId: 'developer' }, modelLevel: 'codex-standard' },
    { match: { roleId: 'watcher' }, modelLevel: 'codex-cheap' },
  ],
};

export const CODEX_CLAUDE_REVIEW_CONSENSUS_BINDINGS: ProfileBindings = {
  runnerOverrides: CODEX_STANDARD_BINDINGS.runnerOverrides,
  bindingOverrides: [
    ...CODEX_STANDARD_BINDINGS.bindingOverrides,
    { match: { nodeId: 'planReviewSecondary' }, runnerId: 'claude-code', modelLevel: 'deep' },
    { match: { nodeId: 'codeReviewSecondary' }, runnerId: 'claude-code', modelLevel: 'deep' },
  ],
};

export const CLAUDE_CODEX_REVIEW_CONSENSUS_BINDINGS: ProfileBindings = {
  runnerOverrides: CLAUDE_STANDARD_BINDINGS.runnerOverrides,
  bindingOverrides: [
    ...CLAUDE_STANDARD_BINDINGS.bindingOverrides,
    { match: { nodeId: 'planReviewSecondary' }, runnerId: 'codex', modelLevel: 'codex-deep' },
    { match: { nodeId: 'codeReviewSecondary' }, runnerId: 'codex', modelLevel: 'codex-deep' },
  ],
};

export type FeatureDevelopmentProfileSummary = {
  profileId: string;
  version: string;
  pipelineId: string;
  summary: string;
};

export type FeatureDevelopmentProfileEntry = FeatureDevelopmentProfileSummary & {
  profile: TopologyProfile;
  bindings: ProfileBindings;
};

export const FEATURE_DEVELOPMENT_PROFILES = [
  {
    profileId: CLAUDE_STANDARD_PROFILE.profileId,
    version: FEATURE_DEVELOPMENT_PROFILE_VERSION,
    pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    summary: 'Claude Code for all feature-development agent slots; analyst and reviewer use deep, other agent slots use standard.',
    profile: CLAUDE_STANDARD_PROFILE,
    bindings: CLAUDE_STANDARD_BINDINGS,
  },
  {
    profileId: CODEX_STANDARD_PROFILE.profileId,
    version: FEATURE_DEVELOPMENT_PROFILE_VERSION,
    pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    summary: 'Codex for all feature-development agent slots; analyst and reviewer use codex-deep, other agent slots use codex-standard.',
    profile: CODEX_STANDARD_PROFILE,
    bindings: CODEX_STANDARD_BINDINGS,
  },
  {
    profileId: CODEX_CLAUDE_REVIEW_CONSENSUS_PROFILE.profileId,
    version: FEATURE_DEVELOPMENT_PROFILE_VERSION,
    pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    summary: 'Codex mainline with two-lane Claude+Codex consensus for plan and code review.',
    profile: CODEX_CLAUDE_REVIEW_CONSENSUS_PROFILE,
    bindings: CODEX_CLAUDE_REVIEW_CONSENSUS_BINDINGS,
  },
  {
    profileId: CLAUDE_CODEX_REVIEW_CONSENSUS_PROFILE.profileId,
    version: FEATURE_DEVELOPMENT_PROFILE_VERSION,
    pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    summary: 'Claude mainline with two-lane Claude+Codex consensus for plan and code review.',
    profile: CLAUDE_CODEX_REVIEW_CONSENSUS_PROFILE,
    bindings: CLAUDE_CODEX_REVIEW_CONSENSUS_BINDINGS,
  },
  {
    profileId: CODEX_CONSENSUS_PROFILE.profileId,
    version: CODEX_CONSENSUS_PROFILE_VERSION,
    pipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    summary: 'Legacy all-Codex two-lane consensus profile for plan and code review.',
    profile: CODEX_CONSENSUS_PROFILE,
    bindings: CODEX_CONSENSUS_BINDINGS,
  },
] as const satisfies readonly FeatureDevelopmentProfileEntry[];

export function listFeatureDevelopmentProfiles(pipelineId?: string): FeatureDevelopmentProfileSummary[] {
  return FEATURE_DEVELOPMENT_PROFILES
    .filter((entry) => pipelineId === undefined || entry.pipelineId === pipelineId)
    .map(({ profileId, version, pipelineId: entryPipelineId, summary }) => ({
      profileId,
      version,
      pipelineId: entryPipelineId,
      summary,
    }));
}

export function getFeatureDevelopmentProfile(profileId: string): FeatureDevelopmentProfileEntry | undefined {
  return FEATURE_DEVELOPMENT_PROFILES.find((entry) => entry.profileId === profileId);
}

type PipelineProfileAlias = { basePipelineId: string; profileId: string };

export const PIPELINE_PROFILE_ALIASES: Record<string, PipelineProfileAlias> = {
  'feature-development-claude-standard': {
    basePipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    profileId: CLAUDE_STANDARD_PROFILE.profileId,
  },
  'feature-development-codex-standard': {
    basePipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    profileId: CODEX_STANDARD_PROFILE.profileId,
  },
  'feature-development-codex-claude-review-consensus': {
    basePipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    profileId: CODEX_CLAUDE_REVIEW_CONSENSUS_PROFILE.profileId,
  },
  'feature-development-claude-codex-review-consensus': {
    basePipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    profileId: CLAUDE_CODEX_REVIEW_CONSENSUS_PROFILE.profileId,
  },
  'feature-development-codex-consensus': {
    basePipelineId: FEATURE_DEVELOPMENT_PIPELINE_ID,
    profileId: 'codex-consensus',
  },
};

export type ResolvedPipelineProfile = {
  requestedPipelineId: string;
  basePipelineId: string;
  profileId?: string;
};

export function resolvePipelineProfile(pipelineId: string, profileId?: string): ResolvedPipelineProfile {
  const alias = PIPELINE_PROFILE_ALIASES[pipelineId];
  if (alias) {
    if (profileId !== undefined && profileId !== alias.profileId) {
      throw new Error(
        `pipeline alias "${pipelineId}" resolves to profileId "${alias.profileId}" but explicit profileId "${profileId}" conflicts`,
      );
    }
    return { requestedPipelineId: pipelineId, basePipelineId: alias.basePipelineId, profileId: alias.profileId };
  }
  if (profileId !== undefined) {
    return { requestedPipelineId: pipelineId, basePipelineId: pipelineId, profileId };
  }
  return { requestedPipelineId: pipelineId, basePipelineId: pipelineId };
}
