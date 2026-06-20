export type GetPrReadinessQueryData = {
  repo: string;
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  sonarProject?: string;
  includeComments?: boolean;
  includeReviewThreads?: boolean;
};

export class GetPrReadinessQuery {
  constructor(readonly data: GetPrReadinessQueryData) {}
}
