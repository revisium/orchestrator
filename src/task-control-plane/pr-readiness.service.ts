import { Injectable } from '@nestjs/common';
import {
  collectPrReadiness,
  type PrReadinessInput,
  type PrReadinessResult,
} from '../poller/pr-readiness-core.js';
import { normalizeIssueAction, normalizeIssueRef } from '../run/issue-ref.js';

export type GetPrReadinessInput = {
  repo: string;
  prNumber?: number;
  headBranch?: string;
  baseBranch?: string;
  sonarProject?: string;
  issueRef?: unknown;
  issueAction?: unknown;
  includeComments?: boolean;
  includeReviewThreads?: boolean;
};

export type PrFeedbackQueue = Pick<
  PrReadinessResult['feedback'],
  | 'developerFixes'
  | 'reviewerQuestions'
  | 'providerWait'
  | 'humanDecisions'
  | 'ignoredNoise'
  | 'residualRisks'
>;

@Injectable()
export class PrReadinessService {
  async getPrReadiness(input: GetPrReadinessInput): Promise<PrReadinessResult> {
    return collectPrReadiness(normalizePrReadinessInput(input));
  }

  async listPrFeedback(input: GetPrReadinessInput): Promise<PrFeedbackQueue> {
    const readiness = await this.getPrReadiness(input);
    return readiness.feedback;
  }

}

export function normalizePrReadinessInput(input: GetPrReadinessInput): PrReadinessInput {
  const issueAction = normalizeIssueAction(input.issueAction, 'issueAction');
  return {
    repo: input.repo,
    prNumber: input.prNumber,
    headBranch: input.headBranch,
    baseBranch: input.baseBranch ?? 'master',
    sonarProject: input.sonarProject,
    issueRef: normalizeIssueRef(input.issueRef, 'issueRef'),
    ...(issueAction ? { issueAction } : {}),
    includeComments: input.includeComments ?? true,
    includeReviewThreads: input.includeReviewThreads ?? true,
  };
}
