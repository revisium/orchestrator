import test from 'node:test';
import assert from 'node:assert/strict';
import { issueRefTag, normalizeIssueRef, normalizeIssueRefIntoParams } from './issue-ref.js';

const ISSUE_REF = {
  repo: 'revisium/orchestrator',
  number: 147,
  url: 'https://github.com/revisium/orchestrator/issues/147',
};

test('normalizeIssueRef accepts the canonical issueRef shape', () => {
  assert.deepEqual(
    normalizeIssueRef({
      repo: 'revisium/orchestrator',
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

test('normalizeIssueRef rejects invalid GitHub repo full names', () => {
  for (const repo of [
    '',
    'owner',
    '/repo',
    'owner/',
    'owner//repo',
    'owner/repo/extra',
    'owner /repo',
    'owner/re po',
    'owner/repo\n',
    'owner/repo\u0000',
    'owner/repo#147',
    'owner/repo?tab=issues',
    'https://github.com/owner/repo',
    'git@github.com:owner/repo.git',
    'Fixes owner/repo',
    'owner/repo Fixes #147',
    '-owner/repo',
    'owner-/repo',
    'owner/repo.git',
    'owner/.',
    'owner/..',
    `owner/${'a'.repeat(101)}`,
  ]) {
    assert.throws(
      () => normalizeIssueRef({ ...ISSUE_REF, repo }),
      /issueRef\.repo/,
      `expected invalid repo to be rejected: ${JSON.stringify(repo)}`,
    );
  }
});

test('normalizeIssueRef keeps valid GitHub repo full names and issueRefTag formatting', () => {
  const sameRepo = normalizeIssueRef({
    repo: 'revisium/orchestrator',
    number: 147,
    url: ISSUE_REF.url,
  });
  const crossRepo = normalizeIssueRef({
    repo: 'another-owner/repo.name_1-2',
    number: 147,
    url: 'https://github.com/another-owner/repo.name_1-2/issues/147',
  });
  const dotRepo = normalizeIssueRef({
    repo: 'org-name/.github',
    number: 1,
    url: 'https://github.com/org-name/.github/issues/1',
  });

  assert.deepEqual(sameRepo, ISSUE_REF);
  assert.equal(issueRefTag(sameRepo, 'REVISIUM/ORCHESTRATOR'), '#147');
  assert.equal(issueRefTag(crossRepo, 'revisium/orchestrator'), 'another-owner/repo.name_1-2#147');
  assert.equal(dotRepo?.repo, 'org-name/.github');
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
