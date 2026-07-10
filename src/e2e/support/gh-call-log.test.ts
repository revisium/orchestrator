import test from 'node:test';
import assert from 'node:assert/strict';
import { caseGhCallBoundary, reviewReplyBodiesSince } from './gh-call-log.js';

test('case GH call slice finds branchless GraphQL replies without historical matches', () => {
  const calls = [[
    'api',
    'graphql',
    '-f',
    'query=mutation { addPullRequestReviewThreadReply(input: {}) { clientMutationId } }',
    '-f',
    'body=historical matching reply',
  ]];
  const boundary = caseGhCallBoundary(calls);

  calls.push(['pr', 'view', 'feat/current-case', '--repo', 'e2e/repo']);
  calls.push([
    'api',
    'graphql',
    '-f',
    'query=mutation { addPullRequestReviewThreadReply(input: {}) { clientMutationId } }',
    '-f',
    'body=current case reply',
  ]);

  assert.deepEqual(reviewReplyBodiesSince(calls, boundary), ['current case reply']);
});
