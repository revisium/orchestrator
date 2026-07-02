import type { BindingOverride } from '../pipeline/route-contract.js';
import type { TopologyProfile } from '../pipeline-core/materialize.js';

export const CONSENSUS_TOGGLE_ALLOWLIST: Record<string, string[]> = {
  'feature-development': ['planReviewer', 'codeReview'],
};

export const CODEX_CONSENSUS_PROFILE: TopologyProfile = {
  profileId: 'codex-consensus',
  pipelineId: 'feature-development',
  toggles: [
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
  ],
};

export const CODEX_CONSENSUS_PROFILE_VERSION = '1';

export const CODEX_CONSENSUS_BINDINGS: {
  runnerOverrides: Record<string, string>;
  bindingOverrides: BindingOverride[];
} = {
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

type PipelineProfileAlias = { basePipelineId: string; profileId: string };

export const PIPELINE_PROFILE_ALIASES: Record<string, PipelineProfileAlias> = {
  'feature-development-codex-consensus': {
    basePipelineId: 'feature-development',
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
