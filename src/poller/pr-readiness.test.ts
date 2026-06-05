import test from 'node:test';
import assert from 'node:assert/strict';
import { run, type PollInput, type ExecGhFn } from './pr-readiness.js';
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
) {
  const fn: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('pr list')) {
      if (prList === null) throw new Error(`Unexpected gh pr list call: ${key}`);
      return JSON.stringify(prList);
    }
    if (key.includes('statusCheckRollup')) return JSON.stringify(prView);
    if (key.includes('reviews')) return JSON.stringify(reviews);
    if (key.includes('issues') && key.includes('comments')) return JSON.stringify(issueComments);
    if (key.includes('comments')) return JSON.stringify(comments);
    throw new Error(`Unexpected gh call: ${key}`);
  };
  return fn;
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

test('sonar_project absent: sonar_issues is empty, no Sonar call made', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  let sonarCalled = false;
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('sonarcloud')) { sonarCalled = true; return '{}'; }
    if (key.includes('statusCheckRollup')) return JSON.stringify(terminalView);
    if (key.includes('reviews')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected: ${key}`);
  };

  const result = await run(BASE_INPUT, STEP, execGh);

  assert.equal(sonarCalled, false);
  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_issues: unknown[] };
  assert.deepEqual(inp.sonar_issues, []);
});

test('Sonar API unavailable: sonar_unavailable:true flag, judge step still emitted', async () => {
  const terminalView = prViewResponse([checkRun('Gitar', 'COMPLETED', 'SUCCESS')]);
  const execGh: ExecGhFn = (args) => {
    const key = args.join(' ');
    if (key.includes('sonarcloud')) throw new Error('network error');
    if (key.includes('statusCheckRollup')) return JSON.stringify(terminalView);
    if (key.includes('reviews')) return '[]';
    if (key.includes('comments')) return '[]';
    throw new Error(`Unexpected: ${key}`);
  };
  const input: PollInput = { ...BASE_INPUT, sonar_project: 'my-project' };

  const result = await run(input, STEP, execGh);

  assert.equal(result.nextSteps.length, 1);
  const inp = (result.nextSteps[0]?.input ?? {}) as { sonar_unavailable: boolean; sonar_issues: unknown[] };
  assert.equal(inp.sonar_unavailable, true);
  assert.deepEqual(inp.sonar_issues, []);
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
