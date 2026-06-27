import test from 'node:test';
import assert from 'node:assert/strict';
import { run, defaultFetchSonar, type PollInput, type ExecGhFn, type FetchSonarFn, type SonarResult } from './pr-readiness.js';
import { collectPrReadiness, fetchRequiredCheckNames } from './pr-readiness-core.js';
import { BASE_STEP } from '../worker/test-fixtures.js';

// ─── fixtures ────────────────────────────────────────────────

const BASE_INPUT: PollInput = {
  pr_number: 42,
  repo: 'owner/repo',
  poll_count: 0,
};

const STEP = { ...BASE_STEP, taskId: 'task-1', modelProfile: 'cheap' };

type GhResponse = Record<string, unknown>;

// statusCheckRollup shape helpers
function checkRun(name: string, status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED', conclusion: string | null = null) {
  return { __typename: 'CheckRun', name, status, conclusion };
}

function statusCtx(context: string, state: 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ERROR') {
  return { __typename: 'StatusContext', context, state };
}

function prViewResponse(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    statusCheckRollup: items,
    mergeStateStatus: 'BLOCKED',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
    ...extra,
  };
}

// The reviews/comments endpoints return arrays directly. There are THREE comment-bearing
// surfaces: /pulls/<N>/reviews (review states), /pulls/<N>/comments (inline review comments),
// and /issues/<N>/comments (top-level PR conversation). Route the issue thread before the
// generic comments check since its URL also contains "comments".
function makeFullResponses(
  prView: GhResponse,
  reviews: unknown[] = [],
  comments: unknown[] = [],
  issueComments: unknown[] = [],
  prList: unknown[] | null = null,
  reviewThreads: unknown = reviewThreadsResponse([]),
) {
  const fn: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) {
      if (prList === null) throw new Error(`Unexpected gh pr list call: ${key}`);
      return JSON.stringify(prList);
    }
    if (key.includes('statusCheckRollup')) return JSON.stringify(prView);
    if (key.includes('api graphql')) return JSON.stringify(reviewThreads);
    if (key.includes('reviews')) return JSON.stringify(reviews);
    if (key.includes('issues') && key.includes('comments')) return JSON.stringify(issueComments);
    if (key.includes('comments')) return JSON.stringify(comments);
    throw new Error(`Unexpected gh call: ${key}`);
  };
  return fn;
}

function reviewThreadsResponse(nodes: unknown[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes,
        },
      },
    },
  };
}

function reviewThreadNode(extra: Record<string, unknown> = {}) {
  return {
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    path: 'src/poller/pr-readiness-core.ts',
    line: 666,
    comments: {
      nodes: [
        {
          body: 'Please fetch review threads before returning from this path.',
          url: 'https://github.com/owner/repo/pull/42#discussion_r1',
          author: { login: 'reviewer' },
        },
      ],
    },
    ...extra,
  };
}

// ─── tests ───────────────────────────────────────────────────

test('pending CI: re-queues with incremented poll_count and future runAfter', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'ci-poller');
  assert.equal(ns.kind, 'poll');
  const inp = ns.input as PollInput;
  assert.equal(inp.poll_count, 1);
  assert.ok(ns.runAfter, 'runAfter must be set');
  assert.ok(new Date(ns.runAfter!).getTime() > Date.now() - 1000, 'runAfter must be in the future');
  assert.equal(ns.taskId, STEP.taskId);
  assert.equal(ns.modelProfile, STEP.modelProfile);
  assert.equal(result.needsHuman, undefined);
  assert.deepEqual(result.costs, []);
});

test('pending CI with QUEUED status: re-queues', async () => {
  const pendingView = prViewResponse([checkRun('Gitar', 'QUEUED')]);
  const execGh = makeFullResponses(pendingView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
});

test('pending CI: uses custom modelProfile from step', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);
  const customStep = { ...STEP, modelProfile: 'standard' };

  const result = await run(BASE_INPUT, customStep, execGh);

  assert.equal(result.nextSteps[0]?.modelProfile, 'standard');
});

test('poll_count === maxPolls: returns needsHuman:true, empty nextSteps', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);
  const input: PollInput = { ...BASE_INPUT, poll_count: 20, max_polls: 20 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  const out = result.output as { verdict: string };
  assert.equal(out.verdict, 'timeout');
  assert.ok(result.lesson && result.lesson.length > 0, 'a non-empty lesson must be present');
  assert.match(result.lesson!, new RegExp(String(input.poll_count)), 'lesson references the poll count');
  assert.deepEqual(result.costs, []);
});

test('all checks terminal + CI passed: judge step with ci_passed:true', async () => {
  const terminalView = prViewResponse([
    checkRun('SonarCloud', 'COMPLETED', 'SUCCESS'),
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ]);
  const execGh = makeFullResponses(terminalView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'pr-watcher');
  assert.equal(ns.kind, 'judge');
  const inp = ns.input as { ci_passed: boolean };
  assert.equal(inp.ci_passed, true);
  assert.equal(ns.taskId, STEP.taskId);
  assert.equal(ns.modelProfile, STEP.modelProfile);
  assert.deepEqual(result.costs, []);
});

test('issueRef readiness: missing branch/title linkage needs a human decision', async () => {
  const issueRef = {
    repo: 'owner/repo',
    number: 147,
    url: 'https://github.com/owner/repo/issues/147',
  };
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'master',
    headRefName: 'feat/abcd-add-feature',
    headRefOid: 'sha',
    title: 'Add feature',
  });
  const execGh = makeFullResponses(terminalView);

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42, issueRef }, execGh);

  assert.equal(readiness.verdict, 'needs_human');
  assert.equal(readiness.nextAction, 'human_decision');
  assert.deepEqual(readiness.issueRef, issueRef);
  const linkageDecision = readiness.feedback.humanDecisions.find((decision) => decision.source === 'issue_ref_linkage');
  assert.ok(linkageDecision);
  assert.ok('evidence' in linkageDecision);
  assert.match(linkageDecision.evidence, /branch missing issue-147/);
  assert.match(linkageDecision.evidence, /title missing #147/);
});

test('issueRef readiness: branch and title linkage keep a clean PR ready', async () => {
  const issueRef = {
    repo: 'owner/repo',
    number: 147,
    url: 'https://github.com/owner/repo/issues/147',
  };
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    url: 'https://github.com/owner/repo/pull/42',
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'master',
    headRefName: 'feat/abcd-issue-147-add-feature',
    headRefOid: 'sha',
    title: '#147 Add feature',
  });
  const execGh = makeFullResponses(terminalView);

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42, issueRef }, execGh);

  assert.equal(readiness.verdict, 'ready');
  assert.equal(readiness.nextAction, 'ready_for_merge_gate');
  assert.deepEqual(readiness.issueRef, issueRef);
  assert.deepEqual(readiness.feedback.humanDecisions, []);
});

test('all checks terminal + CI failed: judge step with ci_passed:false', async () => {
  const failedView = prViewResponse([
    checkRun('SonarCloud', 'COMPLETED', 'FAILURE'),
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
  ]);
  const execGh = makeFullResponses(failedView);

  const result = await run(BASE_INPUT, STEP, execGh);

  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'pr-watcher');
  const inp = ns.input as { ci_passed: boolean };
  assert.equal(inp.ci_passed, false);
});

test('SKIPPED and NEUTRAL conclusions treated as passed', async () => {
  const view = prViewResponse([
    checkRun('SonarCloud', 'COMPLETED', 'SKIPPED'),
    checkRun('Gitar', 'COMPLETED', 'NEUTRAL'),
  ]);
  const execGh = makeFullResponses(view);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as { ci_passed: boolean };
  assert.equal(inp.ci_passed, true);
});

test('sonar_project absent: sonar_issues is empty, fetchSonar never called', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const execGh = makeFullResponses(terminalView);
  let sonarCallCount = 0;
  const fakeFetchSonar: FetchSonarFn = async () => {
    sonarCallCount++;
    return { issues: [], hotspots: [], unavailable: false };
  };

  const result = await run(BASE_INPUT, STEP, execGh, fakeFetchSonar);

  assert.equal(sonarCallCount, 0, 'fetchSonar must not be called when sonar_project is absent');
  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_issues: unknown[]; sonar_hotspots_to_review: unknown[] };
  assert.deepEqual(inp.sonar_issues, []);
  assert.deepEqual(inp.sonar_hotspots_to_review, []);
});

test('Sonar API unavailable: sonar_unavailable:true flag, judge step still emitted', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const execGh = makeFullResponses(terminalView);
  const fakeFetchSonar: FetchSonarFn = async () => ({ issues: [], hotspots: [], unavailable: true });
  const input: PollInput = { ...BASE_INPUT, sonar_project: 'my-project' };

  const result = await run(input, STEP, execGh, fakeFetchSonar);

  assert.equal(result.nextSteps.length, 1);
  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_unavailable: boolean; sonar_issues: unknown[]; sonar_hotspots_to_review: unknown[] };
  assert.equal(inp.sonar_unavailable, true);
  assert.deepEqual(inp.sonar_issues, []);
  assert.deepEqual(inp.sonar_hotspots_to_review, []);
});

test('sonar_project present + 2 issues returned: judge input has 2 sonar_issues, hotspots []', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const execGh = makeFullResponses(terminalView);
  const fakeIssues: SonarResult['issues'] = [
    { severity: 'MAJOR', message: 'Cognitive complexity too high', component: 'proj:src/foo.ts', rule: 'typescript:S3776', line: 10 },
    { severity: 'MINOR', message: 'Remove unused import', component: 'proj:src/bar.ts', rule: 'typescript:S1128' },
  ];
  const fakeFetchSonar: FetchSonarFn = async () => ({ issues: fakeIssues, hotspots: [], unavailable: false });
  const input: PollInput = { ...BASE_INPUT, sonar_project: 'my-project' };

  const result = await run(input, STEP, execGh, fakeFetchSonar);

  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_issues: unknown[]; sonar_hotspots_to_review: unknown[]; sonar_unavailable?: boolean };
  assert.equal(inp.sonar_issues.length, 2, '2 issues forwarded to judge');
  assert.deepEqual(inp.sonar_hotspots_to_review, [], 'no hotspots');
  assert.equal(inp.sonar_unavailable, undefined, 'sonar_unavailable must be absent on successful fetch');
});

test('sonar_project present + 1 hotspot returned: sonar_hotspots_to_review has 1 entry', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const execGh = makeFullResponses(terminalView);
  const fakeHotspot: SonarResult['hotspots'][number] = {
    message: 'Hard-coded credentials', component: 'proj:src/config.ts',
    line: 5, securityCategory: 'hardcoded-credentials', vulnerabilityProbability: 'HIGH',
  };
  const fakeFetchSonar: FetchSonarFn = async () => ({ issues: [], hotspots: [fakeHotspot], unavailable: false });
  const input: PollInput = { ...BASE_INPUT, sonar_project: 'my-project' };

  const result = await run(input, STEP, execGh, fakeFetchSonar);

  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_hotspots_to_review: unknown[]; sonar_issues: unknown[] };
  assert.equal(inp.sonar_hotspots_to_review.length, 1, '1 hotspot forwarded to judge');
  assert.deepEqual(inp.sonar_issues, [], 'no issues');
});

test('defaultFetchSonar no-token path: resolves unavailable:true, no network call', async () => {
  const savedToken = process.env['SONAR_TOKEN'];
  delete process.env['SONAR_TOKEN'];
  try {
    const result = await defaultFetchSonar('my-project', 42);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.hotspots, []);
  } finally {
    if (savedToken !== undefined) process.env['SONAR_TOKEN'] = savedToken;
  }
});

test('bot vs human comment separation', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'COMMENTED', body: 'looks good' },
    { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'bot review' },
  ];
  const comments = [
    { user: { login: 'bob', type: 'User' }, path: 'src/foo.ts', line: 10, body: 'nit' },
    { user: { login: 'gitar-bot[bot]', type: 'Bot' }, path: 'src/bar.ts', line: 5, body: 'bot comment' },
  ];
  const execGh = makeFullResponses(terminalView, reviews, comments);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as {
    human_reviews: unknown[];
    human_comments: unknown[];
    bot_comments: unknown[];
  };
  assert.equal(inp.human_reviews.length, 1, 'only human review');
  assert.equal(inp.human_comments.length, 1, 'only human inline comment');
  assert.equal(inp.bot_comments.length, 1, 'only bot inline comment');
});

test('empty statusCheckRollup ([]): re-queues as pending, NOT terminal (BLOCKER 2)', async () => {
  // A freshly created PR has a transiently empty rollup before checks register. It must NOT
  // be declared "terminal & passed" (the old `[].every() === true` bug) — re-queue instead.
  const view = prViewResponse([]);
  const execGh = makeFullResponses(view);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'ci-poller', 'empty rollup must re-queue, not go to the judge');
  assert.equal(ns.kind, 'poll');
  assert.equal((ns.input as PollInput).poll_count, 1);
  assert.equal(result.needsHuman, undefined);
  const out = result.output as { verdict: string };
  assert.equal(out.verdict, 'pending');
});

test('null statusCheckRollup: re-queues as pending, NOT terminal (BLOCKER 2)', async () => {
  const nullView: GhResponse = {
    statusCheckRollup: null,
    mergeStateStatus: 'BLOCKED',
    reviewDecision: '',
    mergeable: 'MERGEABLE',
  };
  const execGh = makeFullResponses(nullView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'ci-poller', 'null rollup must re-queue, not go to the judge');
  assert.equal(ns.kind, 'poll');
  assert.equal((ns.input as PollInput).poll_count, 1);
  assert.equal(result.needsHuman, undefined);
});

test('PR state MERGED (even with pending/empty rollup): stops, verdict merged, not needsHuman', async () => {
  // PR state takes priority over check state — a merged PR may still carry an empty rollup.
  const mergedView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')], { state: 'MERGED' });
  const execGh = makeFullResponses(mergedView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 0, 'no re-queue and no judge step for a merged PR');
  assert.notEqual(result.needsHuman, true, 'merged work is done — no human needed');
  const out = result.output as { verdict: string; pr_number: number };
  assert.equal(out.verdict, 'merged');
  assert.equal(out.pr_number, BASE_INPUT.pr_number);
});

test('PR state CLOSED (not merged): stops with needsHuman:true and a lesson', async () => {
  const closedView = prViewResponse([], { state: 'CLOSED' });
  const execGh = makeFullResponses(closedView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 0, 'no re-queue and no judge step for a closed PR');
  assert.equal(result.needsHuman, true);
  const out = result.output as { verdict: string; pr_number: number };
  assert.equal(out.verdict, 'closed');
  assert.ok(result.lesson, 'a lesson must be set');
  assert.match(result.lesson!, /closed without merging/);
});

test('PR state OPEN: regression — pending/terminal still driven by checks', async () => {
  const openPending = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')], { state: 'OPEN' });
  const pendingResult = await run(BASE_INPUT, STEP, makeFullResponses(openPending));
  assert.equal(pendingResult.nextSteps[0]?.role, 'ci-poller', 'OPEN + pending checks → re-queue');

  const openTerminal = prViewResponse([checkRun('SonarCloud', 'COMPLETED', 'SUCCESS')], { state: 'OPEN' });
  const terminalResult = await run(BASE_INPUT, STEP, makeFullResponses(openTerminal));
  assert.equal(terminalResult.nextSteps[0]?.role, 'pr-watcher', 'OPEN + terminal checks → judge');
});

test('draft PR with all checks passing: re-queues, NEVER handed to the judge', async () => {
  // A draft is a not-ready signal regardless of check state — passing CI must not route a draft
  // to the judge. Take the pending path (re-queue) instead.
  const draftView = prViewResponse([checkRun('SonarCloud', 'COMPLETED', 'SUCCESS')], { isDraft: true });
  const execGh = makeFullResponses(draftView);

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'ci-poller', 'draft must re-queue, not go to the judge');
  assert.equal(ns.kind, 'poll');
  assert.equal((ns.input as PollInput).poll_count, 1);
  assert.notEqual(result.needsHuman, true);
  const out = result.output as { verdict: string };
  assert.equal(out.verdict, 'draft');
});

test('draft PR at poll_count === maxPolls: needsHuman with a draft lesson', async () => {
  const draftView = prViewResponse([checkRun('SonarCloud', 'COMPLETED', 'SUCCESS')], { isDraft: true });
  const execGh = makeFullResponses(draftView);
  const input: PollInput = { ...BASE_INPUT, poll_count: 20, max_polls: 20 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0, 'no judge step for a draft that timed out');
  assert.ok(result.lesson && result.lesson.length > 0, 'a non-empty lesson must be present');
  assert.match(result.lesson!, /still a draft/);
  assert.match(result.lesson!, new RegExp(String(input.poll_count)), 'lesson references the poll count');
});

test('MCP readiness: draft path includes fetched unresolved review threads by default', async () => {
  const draftView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    state: 'OPEN',
    isDraft: true,
  });
  const execGh = makeFullResponses(
    draftView,
    [],
    [],
    [],
    null,
    reviewThreadsResponse([reviewThreadNode()]),
  );

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42 }, execGh);

  assert.equal(readiness.verdict, 'waiting');
  assert.equal(readiness.pr.draft, true);
  assert.equal(readiness.reviewThreads.included, true);
  assert.equal(readiness.reviewThreads.unresolvedCount, 1);
  assert.equal(readiness.reviewThreads.items[0]?.id, 'thread-1');
  assert.equal(readiness.feedback.developerFixes[0]?.source, 'review_thread');
  assert.match(readiness.feedback.developerFixes[0]?.summary ?? '', /fetch review threads/);
});

test('MCP readiness: pending path includes fetched unresolved review threads by default', async () => {
  const pendingView = prViewResponse([checkRun('Gitar', 'IN_PROGRESS')], {
    number: 42,
    state: 'OPEN',
  });
  const execGh = makeFullResponses(
    pendingView,
    [],
    [],
    [],
    null,
    reviewThreadsResponse([reviewThreadNode({ id: 'thread-2' })]),
  );

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42 }, execGh);

  assert.equal(readiness.verdict, 'waiting');
  assert.equal(readiness.nextAction, 'watcher_wait');
  assert.equal(readiness.reviewThreads.included, true);
  assert.equal(readiness.reviewThreads.unresolvedCount, 1);
  assert.equal(readiness.reviewThreads.items[0]?.id, 'thread-2');
  assert.equal(readiness.feedback.developerFixes[0]?.source, 'review_thread');
  assert.match(readiness.feedback.developerFixes[0]?.summary ?? '', /fetch review threads/);
});

test('unknown __typename node: terminal but never counted as passed (fails closed)', async () => {
  // A node whose __typename is neither CheckRun nor StatusContext has no SUCCESS state, so it
  // can never be a pass. It is terminal (not PENDING) → routes to the judge with ci_passed:false.
  const view = prViewResponse([{ __typename: 'MysteryNode', name: 'mystery-gate' }]);
  const execGh = makeFullResponses(view);

  const result = await run(BASE_INPUT, STEP, execGh);

  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'pr-watcher', 'unknown terminal node still resolves to the judge');
  assert.equal((ns.input as { ci_passed: boolean }).ci_passed, false, 'unknown node must not pass');
});

test('CheckRun COMPLETED with conclusion null: not passed (ci_passed false)', async () => {
  const view = prViewResponse([checkRun('Flaky', 'COMPLETED', null)]);
  const execGh = makeFullResponses(view);

  const result = await run(BASE_INPUT, STEP, execGh);

  const ns = result.nextSteps[0];
  assert.equal(ns.role, 'pr-watcher');
  assert.equal((ns.input as { ci_passed: boolean }).ci_passed, false);
});

test('human_reviews carries .state; an APPROVED human review is not a blocking signal', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', body: 'lgtm' },
    { user: { login: 'bob', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'fix this' },
    { user: { login: 'coderabbitai[bot]', type: 'Bot' }, state: 'COMMENTED', body: 'bot review' },
  ];
  const execGh = makeFullResponses(terminalView, reviews);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as {
    human_reviews: Array<{ user: { login: string }; state: string }>;
    open_threads?: unknown;
  };
  assert.equal(inp.open_threads, undefined, 'the misleading open_threads field is gone');
  assert.equal(inp.human_reviews.length, 2, 'bot review excluded, both human reviews kept');
  const approved = inp.human_reviews.find((r) => r.user.login === 'alice');
  const changes = inp.human_reviews.find((r) => r.user.login === 'bob');
  // The poller does not classify blocking — it preserves .state so the judge can tell an
  // approval (APPROVED) apart from a blocking change-request (CHANGES_REQUESTED).
  assert.equal(approved?.state, 'APPROVED');
  assert.equal(changes?.state, 'CHANGES_REQUESTED');
});

test('human_reviews collapses to the LATEST review per author (stale CHANGES_REQUESTED dropped)', async () => {
  // GitHub returns reviews chronologically; a reviewer may CHANGES_REQUESTED then later APPROVE.
  // Only the latest per author is the effective state — the stale CHANGES_REQUESTED must not block.
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const reviews = [
    { user: { login: 'alice', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'fix this' },
    { user: { login: 'alice', type: 'User' }, state: 'APPROVED', body: 'thanks, lgtm' },
    { user: { login: 'bob', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'still broken' },
  ];
  const execGh = makeFullResponses(terminalView, reviews);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as {
    human_reviews: Array<{ user: { login: string }; state: string }>;
  };
  assert.equal(inp.human_reviews.length, 2, 'one entry per author (alice collapsed, bob kept)');
  const alice = inp.human_reviews.filter((r) => r.user.login === 'alice');
  assert.equal(alice.length, 1, "alice's stale CHANGES_REQUESTED is dropped");
  assert.equal(alice[0]?.state, 'APPROVED', "alice's latest review (APPROVED) is kept");
  const bob = inp.human_reviews.find((r) => r.user.login === 'bob');
  assert.equal(bob?.state, 'CHANGES_REQUESTED', "a different author's CHANGES_REQUESTED is retained");
});

test('issue (top-level) comments are fetched and merged into human/bot comments', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const reviewComments = [
    { user: { login: 'bob', type: 'User' }, path: 'src/foo.ts', line: 10, body: 'inline nit' },
  ];
  const issueComments = [
    { user: { login: 'carol', type: 'User' }, body: 'LGTM' },
    { user: { login: 'sonarcloud[bot]', type: 'Bot' }, body: 'Quality Gate passed' },
  ];
  const execGh = makeFullResponses(terminalView, [], reviewComments, issueComments);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as {
    human_comments: Array<{ body: string }>;
    bot_comments: Array<{ body: string }>;
  };
  assert.equal(inp.human_comments.length, 2, 'inline review comment + top-level human comment');
  assert.equal(inp.bot_comments.length, 1, 'top-level bot summary comment');
  const bodies = new Set(inp.human_comments.map((c) => c.body));
  assert.ok(bodies.has('inline nit'), 'merged from the review thread');
  assert.ok(bodies.has('LGTM'), 'merged from the top-level PR conversation');
  assert.equal(inp.bot_comments[0]?.body, 'Quality Gate passed');
});

test('maxPolls resolved from input field over env var', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);
  const input: PollInput = { ...BASE_INPUT, poll_count: 5, max_polls: 5 };

  process.env['MAX_POLLS'] = '999'; // should be ignored
  try {
    const result = await run(input, STEP, execGh);
    assert.equal(result.needsHuman, true, 'input.max_polls=5 takes priority over env MAX_POLLS=999');
  } finally {
    delete process.env['MAX_POLLS'];
  }
});

test('malformed MAX_POLLS/POLL_INTERVAL_MS env vars: fall back to defaults, cap still trips', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);
  // poll_count 20 equals DEFAULT_MAX_POLLS; env vars are deliberately malformed
  const input: PollInput = { ...BASE_INPUT, poll_count: 20 };

  process.env['MAX_POLLS'] = 'abc';
  process.env['POLL_INTERVAL_MS'] = 'xyz';
  try {
    const result = await run(input, STEP, execGh);
    assert.equal(result.needsHuman, true, 'malformed MAX_POLLS falls back to default (20); cap trips');
    assert.equal(result.nextSteps.length, 0, 'no re-queue — cap triggered at default');
  } finally {
    delete process.env['MAX_POLLS'];
    delete process.env['POLL_INTERVAL_MS'];
  }
});

test('null user (ghost account): no throw; comment classified as non-bot', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const reviews = [{ user: null, state: 'COMMENTED', body: 'ghost review' }];
  const comments = [{ user: null, body: 'ghost comment' }];
  const execGh = makeFullResponses(terminalView, reviews, comments);

  const result = await run(BASE_INPUT, STEP, execGh);

  const inp = (result.nextSteps[0]?.input ?? {}) as {
    human_comments: unknown[];
    bot_comments: unknown[];
    human_reviews: unknown[];
  };
  assert.equal(inp.bot_comments.length, 0, 'null-user comment is not classified as bot');
  assert.equal(inp.human_comments.length, 1, 'null-user comment classified as non-bot');
  assert.equal(inp.human_reviews.length, 0, 'null-user review is skipped in dedup loop');
});

test('non-JSON gh output: throws descriptive error with label', async () => {
  const execGh: ExecGhFn = (args) => {
    if (args.join(' ').includes('statusCheckRollup')) return 'Error: authentication required';
    return '[]';
  };

  await assert.rejects(
    () => run(BASE_INPUT, STEP, execGh),
    (err: Error) => {
      assert.ok(err.message.includes('non-JSON'), 'error mentions non-JSON');
      assert.ok(err.message.includes('pr view'), 'error mentions the pr view label');
      return true;
    },
  );
});

test('poll_count incremented carries forward all other input fields', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView);
  const input: PollInput = {
    pr_number: 99,
    repo: 'acme/app',
    sonar_project: 'acme',
    poll_count: 3,
    poll_interval_ms: 5000,
    max_polls: 10,
  };

  const result = await run(input, STEP, execGh);

  const ns = result.nextSteps[0];
  const inp = ns.input as PollInput;
  assert.equal(inp.pr_number, 99);
  assert.equal(inp.repo, 'acme/app');
  assert.equal(inp.sonar_project, 'acme');
  assert.equal(inp.poll_count, 4);
  assert.equal(inp.poll_interval_ms, 5000);
  assert.equal(inp.max_polls, 10);
});

// ─── PR resolution tests ─────────────────────────────────────

test('resolve from head_branch when pr_number absent: uses resolved number, re-queue carries it', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView, [], [], [], [
    { number: 99, baseRefName: 'master', state: 'OPEN' },
  ]);
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  const inp = result.nextSteps[0]?.input as PollInput;
  assert.equal(inp.pr_number, 99, 'resolved pr_number threaded into re-queue');
  assert.deepEqual(result.costs, []);
});

test('resolve from head_branch: 0 PRs → needsHuman, lesson mentions the branch name', async () => {
  const execGh = makeFullResponses(prViewResponse([]), [], [], [], []);
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.ok(result.lesson?.includes('feat/my-feature'), 'lesson mentions branch name');
  assert.deepEqual(result.costs, []);
});

test('resolve from head_branch: 2 PRs, exactly one on master → picks master PR', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView, [], [], [], [
    { number: 10, baseRefName: 'develop', state: 'OPEN' },
    { number: 20, baseRefName: 'master', state: 'OPEN' },
  ]);
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  assert.equal((result.nextSteps[0]?.input as PollInput).pr_number, 20, 'picks PR whose base is master');
});

test('resolve from head_branch: 2 PRs both on master → needsHuman, lesson lists both candidates', async () => {
  const execGh = makeFullResponses(prViewResponse([]), [], [], [], [
    { number: 10, baseRefName: 'master', state: 'OPEN' },
    { number: 20, baseRefName: 'master', state: 'OPEN' },
  ]);
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.ok(result.lesson?.includes('10'), 'lesson lists candidate #10');
  assert.ok(result.lesson?.includes('20'), 'lesson lists candidate #20');
  assert.deepEqual(result.costs, []);
});

test('neither pr_number nor head_branch → needsHuman, lesson mentions both fields', async () => {
  const execGh: ExecGhFn = () => { throw new Error('should not be called'); };
  const input: PollInput = { repo: 'owner/repo', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.ok(result.lesson?.includes('pr_number') && result.lesson?.includes('head_branch'));
  assert.deepEqual(result.costs, []);
});

test('base_branch override: picks PR on specified base, not default master', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh = makeFullResponses(pendingView, [], [], [], [
    { number: 10, baseRefName: 'master', state: 'OPEN' },
    { number: 20, baseRefName: 'develop', state: 'OPEN' },
  ]);
  const input: PollInput = {
    repo: 'owner/repo',
    head_branch: 'feat/my-feature',
    base_branch: 'develop',
    poll_count: 0,
  };

  const result = await run(input, STEP, execGh);

  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  assert.equal((result.nextSteps[0]?.input as PollInput).pr_number, 20, 'picks PR on develop (override)');
});

test('stale pr_number: gh pr view throws, recovers via head_branch, proceeds normally', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) return JSON.stringify([{ number: 77, baseRefName: 'master', state: 'OPEN' }]);
    if (key.includes('pr view 42')) throw new Error('Could not find pull request for "42"');
    if (key.includes('statusCheckRollup')) return JSON.stringify(pendingView);
    if (key.includes('reviews')) return '[]';
    if (key.includes('issues') && key.includes('comments')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected gh call: ${key}`);
  };
  const input: PollInput = { pr_number: 42, repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, undefined, 'stale pr_number recovered — no error thrown');
  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  assert.equal((result.nextSteps[0]?.input as PollInput).pr_number, 77, 'recovered pr_number forwarded');
});

test('regression: pr_number present and valid → no gh pr list call made', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  let prListCalled = false;
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) { prListCalled = true; return '[]'; }
    if (key.includes('statusCheckRollup')) return JSON.stringify(pendingView);
    if (key.includes('reviews')) return '[]';
    if (key.includes('issues') && key.includes('comments')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected gh call: ${key}`);
  };

  await run(BASE_INPUT, STEP, execGh);

  assert.equal(prListCalled, false, 'gh pr list must NOT be called when pr_number is present and valid');
});

// ─── FIX 2: base_branch honored in all cases ─────────────────

test('FIX2: single open PR on wrong base → needsHuman (base mismatch)', async () => {
  // One PR exists but its baseRefName is 'develop', not the default 'master'.
  // resolvePrByBranch must filter by base FIRST and return needsHuman, not return the wrong PR.
  const execGh = makeFullResponses(prViewResponse([]), [], [], [], [
    { number: 99, baseRefName: 'develop', state: 'OPEN' },
  ]);
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.deepEqual(result.costs, []);
});

// ─── FIX 4: CLOSED pr_number recovery ────────────────────────

test('FIX4: CLOSED pr_number + head_branch has a new OPEN PR → recovers to that PR', async () => {
  const closedView = prViewResponse([], { state: 'CLOSED' });
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) return JSON.stringify([{ number: 77, baseRefName: 'master', state: 'OPEN' }]);
    if (key.includes('pr view 42')) return JSON.stringify(closedView);
    if (key.includes('statusCheckRollup')) return JSON.stringify(pendingView); // pr view 77
    if (key.includes('reviews')) return '[]';
    if (key.includes('issues') && key.includes('comments')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { pr_number: 42, repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, undefined, 'recovered from closed pr_number — no needsHuman');
  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  assert.equal((result.nextSteps[0]?.input as PollInput).pr_number, 77, 'recovered pr_number forwarded');
});

test('FIX4: CLOSED pr_number + no other open PR → needsHuman (closed), no throw', async () => {
  const closedView = prViewResponse([], { state: 'CLOSED' });
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) return JSON.stringify([]); // no open PRs on any base
    if (key.includes('statusCheckRollup')) return JSON.stringify(closedView);
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { pr_number: 42, repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.equal((result.output as { verdict: string }).verdict, 'closed');
  assert.deepEqual(result.costs, []);
});

test('FIX4: branch-resolved PR then view shows CLOSED (TOCTOU) → controlled needsHuman, no throw, no loop', async () => {
  // pr_number absent → resolved from branch → pr view returns CLOSED (race condition)
  // Must NOT re-resolve again (no infinite loop); must return needsHuman with verdict:'closed'.
  const closedView = prViewResponse([], { state: 'CLOSED' });
  let prListCallCount = 0;
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) {
      prListCallCount++;
      return JSON.stringify([{ number: 77, baseRefName: 'master', state: 'OPEN' }]);
    }
    if (key.includes('statusCheckRollup')) return JSON.stringify(closedView);
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, true);
  assert.equal(result.nextSteps.length, 0);
  assert.equal((result.output as { verdict: string }).verdict, 'closed');
  assert.equal(prListCallCount, 1, 'gh pr list called exactly once — no loop');
  assert.deepEqual(result.costs, []);
});

// ─── FIX 5: error discrimination ─────────────────────────────

test('FIX5: transient gh pr view error (non-not-found) propagates — no silent re-resolve', async () => {
  let prListCalled = false;
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) { prListCalled = true; return '[]'; }
    if (key.includes('statusCheckRollup')) throw new Error('rate limit exceeded after 60s');
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { pr_number: 42, repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  await assert.rejects(
    () => run(input, STEP, execGh),
    (err: Error) => {
      assert.ok(err.message.includes('rate limit'), 'transient error propagates unchanged');
      return true;
    },
  );
  assert.equal(prListCalled, false, 'gh pr list must NOT be called for transient errors');
});

test('FIX5: not-found gh pr view error + head_branch → recovers to branch PR', async () => {
  const pendingView = prViewResponse([checkRun('SonarCloud', 'IN_PROGRESS')]);
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) return JSON.stringify([{ number: 77, baseRefName: 'master', state: 'OPEN' }]);
    if (key.includes('pr view 42')) throw new Error('pull request not found');
    if (key.includes('statusCheckRollup')) return JSON.stringify(pendingView); // pr view 77
    if (key.includes('reviews')) return '[]';
    if (key.includes('issues') && key.includes('comments')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { pr_number: 42, repo: 'owner/repo', head_branch: 'feat/my-feature', poll_count: 0 };

  const result = await run(input, STEP, execGh);

  assert.equal(result.needsHuman, undefined, 'not-found error recovered via head_branch');
  assert.equal(result.nextSteps[0]?.role, 'ci-poller');
  assert.equal((result.nextSteps[0]?.input as PollInput).pr_number, 77, 'recovered pr_number forwarded');
});

test('MCP readiness: green checks + stale rate-limit comment ⇒ ready, provider wait informational (regression for #144)', async () => {
  // Regression for #144: a CodeRabbit rate-limit bot comment is stale relative to the current
  // green head (checks already terminal), so it must NOT hard-force a `waiting` verdict. It is
  // surfaced as an informational (non-blocking) providerWait and the verdict is `ready`.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN', url: 'https://github.com/owner/repo/pull/42' });
  const issueComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      body: 'Review did not start because the provider rate limit was reached. Please wait and retry later.',
    },
  ];
  const execGh = makeFullResponses(terminalView, [], [], issueComments);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(readiness.verdict, 'ready', 'green checks + stale comment must not block readiness');
  assert.equal(readiness.nextAction, 'ready_for_merge_gate');
  // The rate-limit comment is still detected (informational) — it just no longer overrides.
  assert.equal(readiness.providerState.codeRabbit?.reason, 'provider_limit');
  assert.equal(readiness.providerState.codeRabbit?.state, 'waiting');
  assert.equal(readiness.feedback.providerWait[0]?.provider, 'CodeRabbit');
  assert.equal(readiness.feedback.providerWait[0]?.blocking, false, 'comment-derived wait is informational');
  assert.equal(readiness.feedback.providerWait[0]?.nature, 'informational');
  assert.match(readiness.evidence.join('\n'), /CodeRabbit provider\/rate limit/);
  assert.match(readiness.evidence.join('\n'), /informational/i);
  assert.match(readiness.evidence.join('\n'), /not blocking/i);
});

test('MCP readiness: stale review_in_progress comment ⇒ ready, provider wait informational (symmetric guard for #144)', async () => {
  // Symmetry guard for #144: `review_in_progress` is the OTHER reason the removed override handled.
  // With a terminal CodeRabbit SUCCESS check, the "CodeRabbit is currently reviewing" comment is
  // stale relative to the current green head, so it must NOT hard-force a `waiting` verdict. It is
  // surfaced as an informational (non-blocking) providerWait and the verdict is `ready` — mirroring
  // the provider_limit test above.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN', url: 'https://github.com/owner/repo/pull/42' });
  const issueComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      body: 'CodeRabbit is currently reviewing this pull request.',
    },
  ];
  const execGh = makeFullResponses(terminalView, [], [], issueComments);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(readiness.verdict, 'ready', 'green checks + stale review_in_progress comment must not block readiness');
  assert.equal(readiness.nextAction, 'ready_for_merge_gate');
  assert.equal(readiness.providerState.codeRabbit?.reason, 'review_in_progress');
  assert.equal(readiness.providerState.codeRabbit?.state, 'waiting');
  assert.equal(readiness.feedback.providerWait[0]?.provider, 'CodeRabbit');
  assert.equal(readiness.feedback.providerWait[0]?.blocking, false, 'comment-derived wait is informational');
  assert.equal(readiness.feedback.providerWait[0]?.nature, 'informational');
  assert.match(readiness.evidence.join('\n'), /informational/i);
  assert.match(readiness.evidence.join('\n'), /not blocking/i);
});

test('MCP readiness: rate-limit warning + zero actionable comments appears in providerWait, NOT developerFixes, verdict not needs_work', async () => {
  // A provider rate-limit comment is provider noise, not a developer fix. It must land in
  // providerWait (informational) and never inflate developerFixes or flip the verdict to needs_work.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const issueComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      body: 'Review did not start because the provider rate limit was reached.',
    },
  ];
  const execGh = makeFullResponses(terminalView, [], [], issueComments);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(readiness.feedback.developerFixes.length, 0, 'rate-limit comment is not a developer fix');
  assert.ok(readiness.feedback.providerWait.length >= 1, 'rate-limit comment surfaces in providerWait');
  assert.notEqual(readiness.verdict, 'needs_work', 'provider noise must not flip verdict to needs_work');
  assert.equal(readiness.feedback.providerWait[0]?.blocking, false);
});

test('MCP readiness: addressed/resolved review threads + green checks + stale rate-limit comment ⇒ ready', async () => {
  // Stale evidence — resolved and outdated review threads (both filtered out of developerFixes)
  // plus a stale rate-limit comment — must not block a green PR. There are zero unresolved
  // actionable threads, so developerFixes stays empty and the verdict resolves to ready.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const issueComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      body: 'Review did not start because the provider rate limit was reached.',
    },
  ];
  const threads = reviewThreadsResponse([
    reviewThreadNode({ id: 'resolved-1', isResolved: true }),   // resolved → filtered out
    reviewThreadNode({ id: 'outdated-1', isOutdated: true }),   // outdated → filtered out
  ]);
  const execGh = makeFullResponses(terminalView, [], [], issueComments, null, threads);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: true },
    execGh,
  );

  assert.equal(readiness.verdict, 'ready', 'resolved/outdated threads + stale comment must not block');
  assert.equal(readiness.reviewThreads.unresolvedCount, 0, 'no actionable unresolved threads');
  assert.equal(readiness.feedback.developerFixes.length, 0);
  assert.equal(readiness.feedback.providerWait[0]?.blocking, false);
  assert.equal(readiness.feedback.providerWait[0]?.nature, 'informational');
});

test('MCP readiness: genuinely-pending CodeRabbit check ⇒ waiting/blocking preserved (regression guard)', async () => {
  // Symmetry guard: a LIVE pending CodeRabbit check is a real readiness blocker. It must keep the
  // `waiting`/`watcher_wait` verdict AND surface a blocking providerWait entry (the informational
  // treatment is only for stale comments on the terminal path).
  const pendingView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'PENDING'),
  ], { number: 42, state: 'OPEN' });
  const execGh = makeFullResponses(pendingView, [], [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(readiness.verdict, 'waiting');
  assert.equal(readiness.nextAction, 'watcher_wait');
  const codeRabbitWait = readiness.feedback.providerWait.find((item) => item.provider === 'CodeRabbit');
  assert.ok(codeRabbitWait, 'a pending CodeRabbit check surfaces a providerWait entry');
  assert.equal(codeRabbitWait?.blocking, true, 'a live pending check is blocking');
  assert.equal(codeRabbitWait?.nature, 'blocking');
  assert.equal(codeRabbitWait?.reason, 'check_pending');
});

test('MCP readiness: pending CodeRabbit check ⇒ resumeAfter is null on the blocking entry', async () => {
  // The synthesized blocking pending-path entry has no retry hint (it is derived from a check
  // status, not a comment), so resumeAfter must be null. This keeps the field shape stable for
  // #142/#143 which will read blocking/nature/resumeAfter together.
  const pendingView = prViewResponse([
    statusCtx('CodeRabbit', 'PENDING'),
  ], { number: 42, state: 'OPEN' });
  const execGh = makeFullResponses(pendingView, [], [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  const codeRabbitWait = readiness.feedback.providerWait.find((item) => item.provider === 'CodeRabbit');
  assert.equal(codeRabbitWait?.resumeAfter, null);
});

// ─── #142: actionable CodeRabbit review-body / bot-comment feedback → developerFixes ──────────

test('#142: actionable CodeRabbit review BODY (Actionable comments posted: N>0) → developerFixes', async () => {
  // CodeRabbit posts a finding as a top-level review body (a Bot-authored `reviews` entry), NOT a
  // resolvable review thread. fetchComments retrieves it but buildFeedback used to discard it (bot
  // reviews are dropped from human_reviews). It must now surface in developerFixes with evidence.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 2**\n\n⚠️ Potential issue: this null check is missing in foo().',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  const crFix = readiness.feedback.developerFixes.find((f) => f.source === 'coderabbit_review_body');
  assert.ok(crFix, 'an actionable CodeRabbit review body must appear in developerFixes');
  assert.match(crFix?.summary ?? '', /Potential issue/, 'summary carries the finding text');
  assert.match(crFix?.evidence ?? '', /Actionable comments posted: 2/, 'evidence preserves the review-body text');
  assert.equal(crFix?.author, 'coderabbitai[bot]');
  assert.equal(readiness.verdict, 'needs_work', 'an actionable finding flips the verdict to needs_work');
  assert.equal(readiness.nextAction, 'developer_fix');
});

test('#142: actionable CodeRabbit inline bot COMMENT (finding marker) → developerFixes with file/line location', async () => {
  // A finding can also arrive as a CodeRabbit inline review comment (a Bot-authored /comments entry).
  // It carries path+line, so the developerFix must preserve that location as evidence.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviewComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      path: 'src/poller/pr-readiness-core.ts',
      line: 517,
      body: '🛠️ Refactor suggestion: extract this branch into a helper.',
    },
  ];
  const execGh = makeFullResponses(terminalView, [], reviewComments, []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  const crFix = readiness.feedback.developerFixes.find((f) => f.source === 'coderabbit_comment');
  assert.ok(crFix, 'an actionable CodeRabbit inline comment must appear in developerFixes');
  assert.equal(crFix?.location, 'src/poller/pr-readiness-core.ts:517', 'file:line location preserved');
  assert.match(crFix?.summary ?? '', /Refactor suggestion/);
  assert.equal(readiness.verdict, 'needs_work');
});

test('#142: addressed/resolved CodeRabbit review body → NOT a developerFix (not a blocker)', async () => {
  // A CodeRabbit review whose findings are reported as addressed/resolved is stale evidence. With
  // green checks and no other blocker it must NOT keep the PR in needs_work.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 0**\n\n✅ Addressed in commit abc123. ⚠️ Potential issue (now resolved).',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source?.startsWith('coderabbit')).length,
    0,
    'addressed/zero-count CodeRabbit feedback must not be a developerFix',
  );
  assert.equal(readiness.verdict, 'ready', 'no actionable finding → ready');
});

test('#142: addressed marker WITH a finding marker and NO zero-count → still dropped (exercises addressed branch)', async () => {
  // Discriminator: the body carries a finding marker (⚠️ Potential issue) AND an addressed marker
  // (✅ Addressed in commit) but NO `Actionable comments posted: 0`, so the count-0 branch cannot
  // suppress it — only CODERABBIT_ADDRESSED_RE can. This test FAILS if the addressed branch is removed.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '⚠️ Potential issue: missing null check in foo(). ✅ Addressed in commit def456.',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source?.startsWith('coderabbit')).length,
    0,
    'a finding reported as addressed (no zero-count) must be dropped via the addressed marker',
  );
  assert.equal(readiness.verdict, 'ready', 'addressed finding → ready');
});

test('#142: a live finding whose prose mentions "outdated comments" is NOT over-dropped', async () => {
  // Conservative-drop guard for nit 1: CODERABBIT_ADDRESSED_RE must be anchored to addressed-markers,
  // not bare "outdated comments". A nitpick asking to remove outdated comments is a REAL finding and
  // must remain a developerFix (only "now outdated" / "marked outdated" mean CodeRabbit handled it).
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '🧹 Nitpick: please remove these outdated comments above the handler.',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  const crFix = readiness.feedback.developerFixes.find((f) => f.source === 'coderabbit_review_body');
  assert.ok(crFix, 'a real nitpick mentioning "outdated comments" must survive as a developerFix');
  assert.match(crFix?.summary ?? '', /remove these outdated comments/);
  assert.equal(readiness.verdict, 'needs_work');
});

test('#142: existing thread-aware review_thread classification still produces a developerFix (no regression)', async () => {
  // Guard the pre-existing path: an unresolved CodeRabbit review THREAD must still be the leading
  // developerFix even with the new review-body path in place.
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    state: 'OPEN',
  });
  const execGh = makeFullResponses(
    terminalView,
    [],
    [],
    [],
    null,
    reviewThreadsResponse([reviewThreadNode()]),
  );

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42, includeReviewThreads: true }, execGh);

  assert.equal(readiness.reviewThreads.unresolvedCount, 1);
  assert.equal(readiness.feedback.developerFixes[0]?.source, 'review_thread', 'review_thread stays the leading fix');
  assert.equal(readiness.feedback.developerFixes[0]?.location, 'src/poller/pr-readiness-core.ts:666', 'thread file:line preserved');
  assert.match(readiness.feedback.developerFixes[0]?.evidence ?? '', /#discussion_r1/, 'thread url evidence preserved');
});

test('#142/#144: provider_limit + review_in_progress comments stay in providerWait, NOT developerFixes', async () => {
  // The actionable-feedback path must EXCLUDE the non-actionable provider states so the WAIT and
  // FIXES buckets never collapse (#144). A provider_limit bot comment is informational providerWait.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const issueComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      body: 'Review did not start because the provider rate limit was reached. CodeRabbit is currently reviewing.',
    },
  ];
  const execGh = makeFullResponses(terminalView, [], [], issueComments);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source?.startsWith('coderabbit')).length,
    0,
    'a provider-state comment must not become a developerFix',
  );
  assert.equal(readiness.feedback.providerWait[0]?.provider, 'CodeRabbit', 'it stays in providerWait');
  assert.equal(readiness.feedback.providerWait[0]?.blocking, false, 'provider wait is informational');
  assert.notEqual(readiness.verdict, 'needs_work');
});

test('#142: no_actionable_comments summary review body → NOT a developerFix', async () => {
  // CodeRabbit's "no actionable comments" summary is the explicit not-a-finding signal — it must
  // never leak into developerFixes even when delivered as a review body.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: 'No actionable comments. Looks good to me!',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source?.startsWith('coderabbit')).length,
    0,
    'a no-actionable-comments review body is not a developerFix',
  );
  assert.equal(readiness.verdict, 'ready');
});

// ─── #142 Finding #2: stale CodeRabbit review bodies are deduped to latest-per-author ──────────

test('#142 Finding #2: older actionable + NEWEST clean CodeRabbit review → NO developerFix (latest wins)', async () => {
  // reviews come back chronological. An earlier CodeRabbit review found an issue, but its newest
  // review is clean ("Actionable comments posted: 0"). Only the latest per author may produce a
  // developerFix, so the stale actionable body must NOT keep the PR in needs_work. FAILS if the
  // coderabbit_reviews dedup is removed.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 1**\n\n⚠️ Potential issue: missing null check in foo().',
    },
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 0**\n\nAll previous findings are resolved.',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source?.startsWith('coderabbit')).length,
    0,
    'a stale actionable CodeRabbit review must not survive a newer clean review',
  );
  assert.notEqual(readiness.verdict, 'needs_work', 'latest clean CodeRabbit review → not needs_work');
});

test('#142 Finding #2: older clean + NEWEST actionable CodeRabbit review → developerFix present', async () => {
  // The symmetric case: the latest CodeRabbit review found a NEW issue. The dedup keeps the latest,
  // so the finding must surface as a developerFix even though an earlier review was clean.
  const terminalView = prViewResponse([
    checkRun('Gitar', 'COMPLETED', 'SUCCESS'),
    statusCtx('CodeRabbit', 'SUCCESS'),
  ], { number: 42, state: 'OPEN' });
  const reviews = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 0**\n\nLooks good so far.',
    },
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      state: 'COMMENTED',
      body: '**Actionable comments posted: 2**\n\n⚠️ Potential issue introduced by the latest push.',
    },
  ];
  const execGh = makeFullResponses(terminalView, reviews, [], []);

  const readiness = await collectPrReadiness(
    { repo: 'owner/repo', prNumber: 42, includeReviewThreads: false },
    execGh,
  );

  const crFix = readiness.feedback.developerFixes.find((f) => f.source === 'coderabbit_review_body');
  assert.ok(crFix, 'the newest actionable CodeRabbit review must surface as a developerFix');
  assert.match(crFix?.summary ?? '', /latest push/, 'the latest review body is the one kept');
  assert.equal(readiness.verdict, 'needs_work');
});

// ─── #142 Finding #1: same inline finding not emitted twice (review_thread vs coderabbit_comment) ───

test('#142 Finding #1: finding as BOTH an unresolved thread AND a coderabbit comment at the same path:line → appears once (the review_thread)', async () => {
  // With includeReviewThreads:true (MCP path) the same CodeRabbit inline finding is both an
  // unresolved review THREAD and a bot review COMMENT. It must appear exactly once — keep the
  // richer review_thread item and drop the duplicate coderabbit_comment at the same path:line.
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    state: 'OPEN',
  });
  // reviewThreadNode() defaults to path 'src/poller/pr-readiness-core.ts', line 666.
  const botComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      path: 'src/poller/pr-readiness-core.ts',
      line: 666,
      body: '⚠️ Potential issue: please fetch review threads before returning from this path.',
    },
  ];
  const execGh = makeFullResponses(
    terminalView,
    [],
    botComments,
    [],
    null,
    reviewThreadsResponse([reviewThreadNode()]),
  );

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42, includeReviewThreads: true }, execGh);

  const atLocation = readiness.feedback.developerFixes.filter((f) => f.location === 'src/poller/pr-readiness-core.ts:666');
  assert.equal(atLocation.length, 1, 'the finding at that path:line appears exactly once');
  assert.equal(atLocation[0]?.source, 'review_thread', 'the kept item is the richer review_thread');
  assert.equal(
    readiness.feedback.developerFixes.filter((f) => f.source === 'coderabbit_comment').length,
    0,
    'the duplicate coderabbit_comment at the same location is dropped',
  );
});

test('#142 Finding #1: a coderabbit comment at a DIFFERENT line than the thread is kept (distinct finding)', async () => {
  // Conservative dedup: only the SAME path:line is a duplicate. A bot comment at a different line is
  // a genuinely distinct finding and must still surface as a coderabbit_comment developerFix.
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')], {
    number: 42,
    state: 'OPEN',
  });
  const botComments = [
    {
      user: { login: 'coderabbitai[bot]', type: 'Bot' },
      path: 'src/poller/pr-readiness-core.ts',
      line: 999, // different line than the thread's 666
      body: '⚠️ Potential issue: unrelated finding on another line.',
    },
  ];
  const execGh = makeFullResponses(
    terminalView,
    [],
    botComments,
    [],
    null,
    reviewThreadsResponse([reviewThreadNode()]),
  );

  const readiness = await collectPrReadiness({ repo: 'owner/repo', prNumber: 42, includeReviewThreads: true }, execGh);

  const crComment = readiness.feedback.developerFixes.find((f) => f.source === 'coderabbit_comment');
  assert.ok(crComment, 'a distinct-line coderabbit comment is not deduped away');
  assert.equal(crComment?.location, 'src/poller/pr-readiness-core.ts:999');
  const threadFix = readiness.feedback.developerFixes.find((f) => f.source === 'review_thread');
  assert.ok(threadFix, 'the review_thread finding is also present');
});

// ─── fetchRequiredCheckNames (PR #135 fix: required-only ci_changes) ──────────

/** A statusCheckRollup.contexts GraphQL payload — `name` for CheckRun, `context` for StatusContext.
 *  Matches reviewThreadsResponse: gh `api graphql` returns the `repository` object at the top level. */
function requiredChecksResponse(nodes: unknown[]) {
  return { repository: { pullRequest: { statusCheckRollup: { contexts: { nodes } } } } };
}

test('fetchRequiredCheckNames: returns only isRequired contexts, mapping CheckRun.name + StatusContext.context', () => {
  const execGh: ExecGhFn = (args) => {
    assert.ok(args.includes('graphql'), 'uses the gh GraphQL api');
    assert.ok(args.some((a) => a.includes('isRequired(pullRequestNumber:$number)')), 'asks isRequired with the PR number arg');
    return JSON.stringify(requiredChecksResponse([
      { __typename: 'CheckRun', name: 'Verify', isRequired: true },
      { __typename: 'CheckRun', name: 'SonarCloud', isRequired: false },
      { __typename: 'StatusContext', context: 'Required checks', isRequired: true },
      { __typename: 'StatusContext', context: 'CodeRabbit', isRequired: false },
    ]));
  };
  const required = fetchRequiredCheckNames('owner/repo', 42, execGh);
  assert.deepEqual([...required].sort(), ['Required checks', 'Verify']);
});

test('fetchRequiredCheckNames: empty/missing rollup → empty set (caller applies fail-safe)', () => {
  const execGh: ExecGhFn = () => JSON.stringify(requiredChecksResponse([]));
  assert.equal(fetchRequiredCheckNames('owner/repo', 42, execGh).size, 0);

  const nullRollup: ExecGhFn = () => JSON.stringify({ repository: { pullRequest: { statusCheckRollup: null } } });
  assert.equal(fetchRequiredCheckNames('owner/repo', 42, nullRollup).size, 0);
});

test('fetchRequiredCheckNames: non-JSON gh output throws (so pollPr can fail-safe to all-failures)', () => {
  const execGh: ExecGhFn = () => 'Error: authentication required';
  assert.throws(() => fetchRequiredCheckNames('owner/repo', 42, execGh), /non-JSON/);
});
