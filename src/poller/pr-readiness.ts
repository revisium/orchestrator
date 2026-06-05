import { execFileSync } from 'node:child_process';
import type { AttemptResult } from '../worker/runner.js';
import type { Step } from '../control-plane/steps.js';

// ─── types ───────────────────────────────────────────────────

export type PollInput = {
  pr_number?: number;        // optional: resolved from head_branch when missing/stale
  repo: string;              // "owner/repo"
  head_branch?: string;      // the PR's head branch — the durable identity key for resolution
  base_branch?: string;      // target base for disambiguation (default "master")
  sonar_project?: string;
  poll_count: number;
  poll_interval_ms?: number;
  max_polls?: number;
};

type CheckRunNode = {
  __typename: 'CheckRun';
  name: string;
  status: 'QUEUED' | 'IN_PROGRESS' | 'COMPLETED';
  conclusion: string | null;
};

type StatusContextNode = {
  __typename: 'StatusContext';
  context: string;
  state: 'PENDING' | 'SUCCESS' | 'FAILURE' | 'ERROR';
};

type CheckItem = CheckRunNode | StatusContextNode;

type ReviewEntry = {
  user: { login: string; type?: string } | null;
  state: string;
  body: string;
};

type CommentEntry = {
  user: { login: string; type?: string } | null;
  path?: string;
  line?: number;
  body: string;
};

export type CiSummary = {
  ci_passed: boolean;
  checks: Array<{ name: string; result: string }>;
  isDraft?: boolean;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergeable?: string;
  sonar_issues: SonarIssue[];
  sonar_unavailable?: boolean;
  // Each entry keeps its .state (APPROVED | COMMENTED | DISMISSED | CHANGES_REQUESTED) so the
  // judge can distinguish an approval from a blocking change-request — the field name no longer
  // implies every human review is blocking.
  human_reviews: ReviewEntry[];
  human_comments: CommentEntry[];
  bot_comments: CommentEntry[];
};

type SonarIssue = {
  severity: string;
  message: string;
  component: string;
};

// Shape returned by `gh pr view --json state,...`
type PrViewData = {
  state?: string;
  isDraft?: boolean;
  statusCheckRollup: CheckItem[] | null;
  mergeStateStatus?: string;
  reviewDecision?: string;
  mergeable?: string;
};

// ─── injectable seam ─────────────────────────────────────────

export type ExecGhFn = (args: string[]) => string;

/** Calls the `gh` CLI with a 60-second OS-level timeout; throws on non-zero exit. */
export function defaultExecGh(args: string[]): string {
  // OS-level timeout + maxBuffer: execFileSync is synchronous and blocks the event loop,
  // so the ScriptRunner's Promise.race timer can never fire. The OS timeout is the real
  // backstop that kills a hung gh call; maxBuffer guards against a runaway response.
  return execFileSync('gh', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
}

/** Coerces `value` to a finite positive number, returning `defaultValue` for NaN, Infinity, or ≤0. */
function toFinitePositive(value: unknown, defaultValue: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

/** Parses JSON returned by `gh`; throws a descriptive Error (not a raw SyntaxError) on failure. */
function parseGhJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`gh returned non-JSON for ${label}: ${raw.slice(0, 200)}`);
  }
}

// ─── PR resolution ──────────────────────────────────────────

type PrListEntry = { number: number; baseRefName: string; state: string };

type OpenPrResult =
  | { kind: 'open'; prNumber: number; prView: PrViewData }
  | { kind: 'merged'; prNumber: number }
  | { kind: 'needsHuman'; verdict: string; lesson: string };

// Matches `gh` CLI not-found errors; other failures (timeout, rate-limit) must NOT trigger recovery.
const NOT_FOUND_RE = /could not resolve|could not find|no pull requests? found|not found/i;

/**
 * Resolves the open PR number for a head branch via `gh pr list --head`.
 * Filters by baseRefName === baseBranch first, then: 0 → needsHuman; 1 → use it; >1 → needsHuman.
 * A single PR targeting a different base is NOT returned.
 */
function resolvePrByBranch(
  repo: string,
  headBranch: string,
  baseBranch: string,
  execGh: ExecGhFn,
): { pr_number: number } | { needsHuman: true; lesson: string } {
  const raw = execGh([
    'pr', 'list', '--repo', repo, '--head', headBranch, '--state', 'open',
    '--json', 'number,baseRefName,state',
  ]);
  const prs = parseGhJson<PrListEntry[]>(raw, `pr list --head ${headBranch}`);
  const onBase = prs.filter((p) => p.baseRefName === baseBranch);

  if (onBase.length === 0) {
    return { needsHuman: true, lesson: `No open PR for head branch "${headBranch}" with base "${baseBranch}" in ${repo} — manual review needed` };
  }
  if (onBase.length === 1) return { pr_number: onBase[0].number };

  const candidates = onBase.map((p) => p.number).join(', ');
  return {
    needsHuman: true,
    lesson: `Ambiguous: ${onBase.length} open PRs for head branch "${headBranch}" targeting base "${baseBranch}" — candidates #${candidates} — manual review needed`,
  };
}

/** Fetches PR view data via `gh pr view`. Throws on any gh failure (caller decides recovery). */
function fetchPrView(prNumber: number, repo: string, execGh: ExecGhFn): PrViewData {
  const raw = execGh([
    'pr', 'view', String(prNumber), '--repo', repo,
    '--json', 'state,isDraft,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable',
  ]);
  return parseGhJson<PrViewData>(raw, `pr view #${prNumber}`);
}

/**
 * Handles a CLOSED pr state. If head_branch is available and we haven't already resolved from it
 * this invocation, attempts to find a replacement open PR. Returns needsHuman on all terminal-closed
 * paths — never throws.
 */
function handleClosedPr(
  prNumber: number,
  resolvedFromBranch: boolean,
  input: PollInput,
  baseBranch: string,
  execGh: ExecGhFn,
): OpenPrResult {
  if (!input.head_branch || resolvedFromBranch) {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${prNumber} was closed without merging — manual review needed` };
  }
  const r = resolvePrByBranch(input.repo, input.head_branch, baseBranch, execGh);
  if ('needsHuman' in r) {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${prNumber} was closed; ${r.lesson}` };
  }
  const newPrView = fetchPrView(r.pr_number, input.repo, execGh);
  if (newPrView.state === 'MERGED') return { kind: 'merged', prNumber: r.pr_number };
  if (newPrView.state === 'CLOSED') {
    return { kind: 'needsHuman', verdict: 'closed', lesson: `PR #${r.pr_number} (recovered via "${input.head_branch}") is also closed — manual review needed` };
  }
  return { kind: 'open', prNumber: r.pr_number, prView: newPrView };
}

/**
 * Resolves the effective open PR and its view data. Handles missing pr_number (resolves from
 * head_branch), not-found stale pr_number (re-resolves from head_branch once), and CLOSED state
 * recovery. Returns a discriminated union so run() needs no further branching on identity.
 */
function resolveOpenPr(input: PollInput, baseBranch: string, execGh: ExecGhFn): OpenPrResult {
  let prNumber = input.pr_number;
  let resolvedFromBranch = false;

  if (!prNumber) {
    if (!input.head_branch) {
      return { kind: 'needsHuman', verdict: 'unresolved', lesson: `ci-poller step has neither pr_number nor head_branch — cannot identify a PR to watch` };
    }
    const r = resolvePrByBranch(input.repo, input.head_branch, baseBranch, execGh);
    if ('needsHuman' in r) return { kind: 'needsHuman', verdict: 'unresolved', lesson: r.lesson };
    prNumber = r.pr_number;
    resolvedFromBranch = true;
  }

  // Fetch the PR view; recover a stale pr_number via head_branch at most once — but ONLY for
  // not-found errors. Transient failures (timeout, rate-limit) must propagate so failStep retries.
  let prViewResult: PrViewData | undefined;
  try {
    prViewResult = fetchPrView(prNumber, input.repo, execGh);
  } catch (err) {
    if (!input.head_branch || resolvedFromBranch || !NOT_FOUND_RE.test(String(err))) {
      throw err;
    }
    const r = resolvePrByBranch(input.repo, input.head_branch, baseBranch, execGh);
    if ('needsHuman' in r) return { kind: 'needsHuman', verdict: 'unresolved', lesson: r.lesson };
    prNumber = r.pr_number;
    resolvedFromBranch = true;
    prViewResult = fetchPrView(prNumber, input.repo, execGh);
  }
  const prView = prViewResult!;

  if (prView.state === 'MERGED') return { kind: 'merged', prNumber };
  if (prView.state === 'CLOSED') return handleClosedPr(prNumber, resolvedFromBranch, input, baseBranch, execGh);
  return { kind: 'open', prNumber, prView };
}

// ─── defaults ────────────────────────────────────────────────

const DEFAULT_MAX_POLLS = 20;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ─── helpers ─────────────────────────────────────────────────

// Enum split: a CheckRun's `status` is CheckStatusState (terminal iff 'COMPLETED'); pass/fail
// lives in `conclusion` (see isPassed), never in `status`. A StatusContext has no such split — its
// `state` carries both lifecycle and outcome, so 'PENDING' is the only non-terminal value there.
function isTerminal(item: CheckItem): boolean {
  if (item.__typename === 'CheckRun') return item.status === 'COMPLETED';
  return item.state !== 'PENDING';
}

function isPassed(item: CheckItem): boolean {
  if (item.__typename === 'CheckRun') {
    return ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(item.conclusion ?? '');
  }
  return item.state === 'SUCCESS';
}

function isBot(user: { login: string; type?: string } | null | undefined): boolean {
  return user?.type === 'Bot';
}

function collectCiChecks(
  items: CheckItem[],
): { pending: boolean; ci_passed: boolean; checks: Array<{ name: string; result: string }> } {
  // An empty rollup (null → [] at the call site, or genuinely []) is TRANSIENT on a freshly
  // created PR: checks have not registered yet. `[].every() === true` would otherwise declare
  // "terminal & passed" and fire the judge before CI runs. Treat empty as PENDING so the poller
  // re-queues; this self-bounds via maxPolls → needsHuman if a repo truly has no checks.
  const pending = items.length === 0 || items.some((item) => !isTerminal(item));
  const ci_passed = !pending && items.every((item) => isPassed(item));
  const checks = items.map((item) => {
    if (item.__typename === 'CheckRun') {
      return { name: item.name, result: item.status === 'COMPLETED' ? (item.conclusion ?? 'unknown') : item.status };
    }
    return { name: item.context, result: item.state };
  });
  return { pending, ci_passed, checks };
}

// Deferred stub — does NOT call gh. `gh api` only talks to api.github.com (it injects
// GitHub auth on every request), so a direct sonarcloud.io call always fails; a live call
// here would be misleading. Real Sonar integration needs a dedicated Sonar host + token and
// is deferred. Nothing functional is lost: the SonarCloud quality-gate verdict is ALREADY
// captured via the "SonarCloud Code Analysis" entry in statusCheckRollup (→ ci_passed).
function fetchSonarIssues(_sonarProject: string): { issues: SonarIssue[]; unavailable: boolean } {
  return { issues: [], unavailable: true };
}

// ─── helpers (continued) ─────────────────────────────────────

/** Gathers sonar issues, reviews, and comments; returns the pr-watcher judge step result. */
function buildJudgeResult(
  input: PollInput,
  step: Step,
  execGh: ExecGhFn,
  prView: { mergeStateStatus?: string; reviewDecision?: string; mergeable?: string },
  ci_passed: boolean,
  checkSummary: Array<{ name: string; result: string }>,
  prNumber: number,
): AttemptResult {
  let sonar_issues: SonarIssue[] = [];
  let sonar_unavailable: boolean | undefined;

  if (input.sonar_project) {
    const sonarResult = fetchSonarIssues(input.sonar_project);
    sonar_issues = sonarResult.issues;
    if (sonarResult.unavailable) sonar_unavailable = true;
  }

  const reviewsRaw = execGh(['api', `repos/${input.repo}/pulls/${prNumber}/reviews`]);
  const reviews = parseGhJson<ReviewEntry[]>(reviewsRaw, `reviews #${prNumber}`);

  const reviewCommentsRaw = execGh(['api', `repos/${input.repo}/pulls/${prNumber}/comments`]);
  const reviewComments = parseGhJson<CommentEntry[]>(reviewCommentsRaw, `review-comments #${prNumber}`);

  const issueCommentsRaw = execGh(['api', `repos/${input.repo}/issues/${prNumber}/comments`]);
  const issueComments = parseGhJson<CommentEntry[]>(issueCommentsRaw, `issue-comments #${prNumber}`);

  const allComments = [...reviewComments, ...issueComments];

  const latestHumanReviewByAuthor = new Map<string, ReviewEntry>();
  for (const r of reviews) {
    if (!r.user || isBot(r.user)) continue;
    latestHumanReviewByAuthor.set(r.user.login, r);
  }
  const human_reviews = [...latestHumanReviewByAuthor.values()];
  const human_comments = allComments.filter((c) => !isBot(c.user));
  const bot_comments = allComments.filter((c) => isBot(c.user));

  const ci_summary: CiSummary = {
    ci_passed,
    checks: checkSummary,
    mergeStateStatus: prView.mergeStateStatus,
    reviewDecision: prView.reviewDecision,
    mergeable: prView.mergeable,
    sonar_issues,
    human_reviews,
    human_comments,
    bot_comments,
    ...(sonar_unavailable ? { sonar_unavailable: true } : {}),
  };

  return {
    output: { verdict: 'terminal', ci_passed },
    nextSteps: [
      {
        role: 'pr-watcher',
        kind: 'judge',
        input: ci_summary,
        taskId: step.taskId,
        modelProfile: step.modelProfile,
      },
    ],
    costs: [],
  };
}

// ─── main script entry ───────────────────────────────────────

/** Polls a GitHub PR for CI readiness; re-queues while pending or hands off to the judge when terminal. */
export async function run(
  input: PollInput,
  step: Step,
  execGh: ExecGhFn = defaultExecGh,
): Promise<AttemptResult> {
  const maxPolls = toFinitePositive(
    input.max_polls ?? process.env['MAX_POLLS'],
    DEFAULT_MAX_POLLS,
  );
  const pollIntervalMs = toFinitePositive(
    input.poll_interval_ms ?? process.env['POLL_INTERVAL_MS'],
    DEFAULT_POLL_INTERVAL_MS,
  );
  const baseBranch = input.base_branch ?? 'master';

  const resolved = resolveOpenPr(input, baseBranch, execGh);

  if (resolved.kind === 'merged') {
    return { output: { verdict: 'merged', pr_number: resolved.prNumber }, nextSteps: [], costs: [] };
  }
  if (resolved.kind === 'needsHuman') {
    return { output: { verdict: resolved.verdict }, nextSteps: [], needsHuman: true, lesson: resolved.lesson, costs: [] };
  }

  const { prNumber, prView } = resolved;

  // A draft PR is NOT ready to judge regardless of check state — draft is a not-ready signal that
  // is often transient (opened-as-draft, then marked ready-for-review). So take the pending path:
  // re-queue to wait for it, self-bounding to needsHuman via maxPolls. This must precede the
  // CI-terminal→judge handoff so a draft with passing checks is never handed to the judge.
  if (prView.isDraft === true) {
    if (input.poll_count >= maxPolls) {
      return {
        output: { verdict: 'draft', poll_count: input.poll_count },
        nextSteps: [],
        needsHuman: true,
        lesson: `PR #${prNumber} is still a draft after ${input.poll_count} polls`,
        costs: [],
      };
    }
    const runAfter = new Date(Date.now() + pollIntervalMs).toISOString();
    return {
      output: { verdict: 'draft', poll_count: input.poll_count },
      nextSteps: [
        {
          role: 'ci-poller',
          kind: 'poll',
          input: { ...input, pr_number: prNumber, poll_count: input.poll_count + 1 },
          runAfter,
          taskId: step.taskId,
          modelProfile: step.modelProfile,
        },
      ],
      costs: [],
    };
  }

  // 1. Fetch unified CI status via statusCheckRollup (mixes CheckRun + StatusContext nodes)
  const checks: CheckItem[] = prView.statusCheckRollup ?? [];
  const { pending, ci_passed, checks: checkSummary } = collectCiChecks(checks);

  if (pending) {
    // CI still in progress
    if (input.poll_count >= maxPolls) {
      const pendingNames = checks
        .filter((item) => !isTerminal(item))
        .map((item) => (item.__typename === 'CheckRun' ? item.name : item.context));
      const lesson =
        `CI polling timed out after ${input.poll_count} polls — checks still pending or absent` +
        (pendingNames.length > 0 ? ` (pending: ${pendingNames.join(', ')})` : '');
      return { output: { verdict: 'timeout', poll_count: input.poll_count, checks: checkSummary }, nextSteps: [], needsHuman: true, lesson, costs: [] };
    }
    const runAfter = new Date(Date.now() + pollIntervalMs).toISOString();
    return {
      output: { verdict: 'pending', poll_count: input.poll_count },
      nextSteps: [
        {
          role: 'ci-poller',
          kind: 'poll',
          input: { ...input, pr_number: prNumber, poll_count: input.poll_count + 1 },
          runAfter,
          taskId: step.taskId,
          modelProfile: step.modelProfile,
        },
      ],
      costs: [],
    };
  }

  // 2. All checks terminal — delegate to helper (sonar, reviews, comments → judge step)
  return buildJudgeResult(input, step, execGh, prView, ci_passed, checkSummary, prNumber);
}
