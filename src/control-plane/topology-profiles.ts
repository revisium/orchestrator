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
