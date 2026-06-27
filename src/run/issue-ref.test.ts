import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIssueRef, normalizeIssueRefIntoParams } from './issue-ref.js';

const ISSUE_REF = {
  repo: 'revisium/orchestrator',
  number: 147,
  url: 'https://github.com/revisium/orchestrator/issues/147',
};

test('normalizeIssueRef accepts the canonical issueRef shape', () => {
  assert.deepEqual(
    normalizeIssueRef({
      repo: ' revisium/orchestrator ',
      number: 147,
      url: ' https://github.com/revisium/orchestrator/issues/147 ',
    }),
    ISSUE_REF,
  );
});

test('normalizeIssueRef rejects malformed issueRef values', () => {
  for (const value of [
    null,
    'issue-147',
    { repo: '', number: 147, url: ISSUE_REF.url },
    { repo: ISSUE_REF.repo, number: 0, url: ISSUE_REF.url },
    { repo: ISSUE_REF.repo, number: 1.5, url: ISSUE_REF.url },
    { repo: ISSUE_REF.repo, number: 147, url: '' },
  ]) {
    assert.throws(() => normalizeIssueRef(value), /issueRef|repo|number|url/);
  }
});

test('normalizeIssueRefIntoParams stores top-level issueRef under public params', () => {
  assert.deepEqual(
    normalizeIssueRefIntoParams({ ticket: 'RV-147' }, ISSUE_REF),
    { ticket: 'RV-147', issueRef: ISSUE_REF },
  );
});

test('normalizeIssueRefIntoParams accepts matching params.issueRef and rejects conflicts', () => {
  assert.deepEqual(
    normalizeIssueRefIntoParams({ issueRef: ISSUE_REF }, { ...ISSUE_REF }),
    { issueRef: ISSUE_REF },
  );

  assert.throws(
    () => normalizeIssueRefIntoParams({ issueRef: ISSUE_REF }, { ...ISSUE_REF, number: 148 }),
    /conflicts with params\.issueRef/,
  );
});
