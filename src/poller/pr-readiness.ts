import { execFileSync } from 'node:child_process';
import type { AttemptResult } from '../worker/runner.js';
import type { Step } from '../control-plane/steps.js';

// ─── types ───────────────────────────────────────────────────

export type PollInput = {
  pr_number: number;
  repo: string;
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
): AttemptResult {
  let sonar_issues: SonarIssue[] = [];
  let sonar_unavailable: boolean | undefined;

  if (input.sonar_project) {
    const sonarResult = fetchSonarIssues(input.sonar_project);
    sonar_issues = sonarResult.issues;
    if (sonarResult.unavailable) sonar_unavailable = true;
  }

  const reviewsRaw = execGh(['api', `repos/${input.repo}/pulls/${input.pr_number}/reviews`]);
  const reviews = parseGhJson<ReviewEntry[]>(reviewsRaw, `reviews #${input.pr_number}`);

  const reviewCommentsRaw = execGh(['api', `repos/${input.repo}/pulls/${input.pr_number}/comments`]);
  const reviewComments = parseGhJson<CommentEntry[]>(reviewCommentsRaw, `review-comments #${input.pr_number}`);

  const issueCommentsRaw = execGh(['api', `repos/${input.repo}/issues/${input.pr_number}/comments`]);
  const issueComments = parseGhJson<CommentEntry[]>(issueCommentsRaw, `issue-comments #${input.pr_number}`);

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

  // 1. Fetch unified CI status via statusCheckRollup (mixes CheckRun + StatusContext nodes)
  const prViewRaw = execGh([
    'pr',
    'view',
    String(input.pr_number),
    '--repo',
    input.repo,
    '--json',
    'state,isDraft,statusCheckRollup,mergeStateStatus,reviewDecision,mergeable',
  ]);

  const prView = parseGhJson<{
    state?: string;
    isDraft?: boolean;
    statusCheckRollup: CheckItem[] | null;
    mergeStateStatus?: string;
    reviewDecision?: string;
    mergeable?: string;
  }>(prViewRaw, `pr view #${input.pr_number}`);

  // Terminal PR-state check FIRST — the PR's own state takes priority over check state, because a
  // merged/closed PR may still carry an empty or stale rollup. Without this the poller would keep
  // re-queuing checks on a finished PR until maxPolls.
  if (prView.state === 'MERGED') {
    // Work is done; nothing left to judge → stop cleanly, no human needed.
    return { output: { verdict: 'merged', pr_number: input.pr_number }, nextSteps: [], costs: [] };
  }
  if (prView.state === 'CLOSED') {
    // Closed-without-merge is an anomaly for an autonomous loop → surface it to a human.
    return {
      output: { verdict: 'closed', pr_number: input.pr_number },
      nextSteps: [],
      needsHuman: true,
      lesson: `PR #${input.pr_number} was closed without merging — manual review needed`,
      costs: [],
    };
  }

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
        lesson: `PR #${input.pr_number} is still a draft after ${input.poll_count} polls`,
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
          input: { ...input, poll_count: input.poll_count + 1 },
          runAfter,
          taskId: step.taskId,
          modelProfile: step.modelProfile,
        },
      ],
      costs: [],
    };
  }

  const checks: CheckItem[] = prView.statusCheckRollup ?? [];
  const { pending, ci_passed, checks: checkSummary } = collectCiChecks(checks);

  if (pending) {
    // CI still in progress
    if (input.poll_count >= maxPolls) {
      const verdict = {
        verdict: 'timeout',
        poll_count: input.poll_count,
        checks: checkSummary,
      };
      const pendingNames = checks
        .filter((item) => !isTerminal(item))
        .map((item) => (item.__typename === 'CheckRun' ? item.name : item.context));
      const lesson =
        `CI polling timed out after ${input.poll_count} polls — checks still pending or absent` +
        (pendingNames.length > 0 ? ` (pending: ${pendingNames.join(', ')})` : '');
      return { output: verdict, nextSteps: [], needsHuman: true, lesson, costs: [] };
    }

    const runAfter = new Date(Date.now() + pollIntervalMs).toISOString();
    return {
      output: { verdict: 'pending', poll_count: input.poll_count },
      nextSteps: [
        {
          role: 'ci-poller',
          kind: 'poll',
          input: { ...input, poll_count: input.poll_count + 1 },
          runAfter,
          taskId: step.taskId,
          modelProfile: step.modelProfile,
        },
      ],
      costs: [],
    };
  }

  // 2. All checks terminal — delegate to helper (sonar, reviews, comments → judge step)
  return buildJudgeResult(input, step, execGh, prView, ci_passed, checkSummary);
}
