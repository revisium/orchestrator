export type GetPrReadinessQueryData = {
  repo: string;
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  sonarProject?: string;
  issueRef?: { repo: string; number: number; url: string };
  issueAction?: 'close' | 'refs' | 'none';
  includeComments?: boolean;
  includeReviewThreads?: boolean;
};

export class GetPrReadinessQuery {
  constructor(readonly data: GetPrReadinessQueryData) {}
}
