import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrReadinessInput, PrReadinessService } from './pr-readiness.service.js';

const ISSUE_REF = {
  repo: 'revisium/orchestrator',
  number: 147,
  url: 'https://github.com/revisium/orchestrator/issues/147',
};

test('PrReadinessService rejects malformed issueRef before readiness collection', async () => {
  const service = new PrReadinessService();

  await assert.rejects(
    () => service.getPrReadiness({
      repo: 'revisium/orchestrator',
      prNumber: 191,
      issueRef: { ...ISSUE_REF, number: 0 },
    }),
    /issueRef\.number must be a positive integer/,
  );
});

test('normalizePrReadinessInput forwards normalized issueRef to readiness core input', () => {
  assert.deepEqual(
    normalizePrReadinessInput({
      repo: 'revisium/orchestrator',
      prNumber: 191,
      issueRef: {
        repo: ' revisium/orchestrator ',
        number: 147,
        url: ' https://github.com/revisium/orchestrator/issues/147 ',
      },
      includeComments: false,
      includeReviewThreads: false,
    }),
    {
      repo: 'revisium/orchestrator',
      prNumber: 191,
      headBranch: undefined,
      baseBranch: 'master',
      sonarProject: undefined,
      issueRef: ISSUE_REF,
      includeComments: false,
      includeReviewThreads: false,
    },
  );
});
