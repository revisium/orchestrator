/**
 * integrator.ts — deterministic, replay-safe code integrator.
 *
 * DBOS-SEALED: zero @dbos-inc imports. Registration happens in PipelineService ctor.
 *
 * Exposes:
 *   - integrate(input, deps)     — REAL integrator (live only); git/gh side effects; resumable.
 *   - stubIntegrate(input)       — STUB (script only); ZERO external effects; pure + deterministic.
 *   - preflightLive(taskId, base, deps) — LIVE PREFLIGHT; clean check + base freshness; one-shot.
 *   - IntegratorService          — @Injectable wrapper with bound arrow properties.
 *
 * The pure primitives (resolveExecutable, branchName, parseOwnerRepo) and shared types live in
 * sibling modules (integrator-git / -branch-naming / -remote / -types) and are re-exported here so
 * the public import path ('./integrator.js') is unchanged.
 */
import { Inject, Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';
import { collectPrReadiness, type ReviewThread } from '../poller/pr-readiness-core.js';
import { RunService } from '../revisium/run.service.js';
import { resolveGhAccount, resolvePinnedGh } from './gh-identity.js';
import type { ExecFn, IntegratorBlocked } from './integrator-types.js';
import { gitAbsPath, branchExists, countAhead } from './integrator-git.js';
import { resolveOwnerRepo } from './integrator-remote.js';
import { branchName } from './integrator-branch-naming.js';

// Public-API re-exports — the implementations now live in focused sibling modules, but callers
// (worktree.service, git-worktree-manager, the test kit) keep importing from './integrator.js'.
export { resolveExecutable } from './integrator-git.js';
export { branchName };
export { parseOwnerRepo } from './integrator-remote.js';
export type { ExecFn, IntegratorBlocked };

// ─── types ────────────────────────────────────────────────────────────────────

export type IntegratorDeps = {
  execGit: ExecFn;
  execGh: ExecGhFn;
  /** BASE checkout resolver (keyed by taskId) — used by the live preflight (runs before the worktree). */
  resolveTaskCwd: (taskId: string) => Promise<string>;
  /** RUN worktree resolver (keyed by runId, plan 0017) — used by integrate() so the commit/push happen
   *  in the run's isolated worktree, never the shared base checkout. */
  resolveRunCwd: (runId: string, taskId: string) => Promise<string>;
};

export type IntegratorInput = {
  runId: string;
  taskId: string;
  title: string;
  base: string;
  /** Hydrated `consumes` for a script node that needs upstream data (plan 0018: respondThreads ← triage). */
  triage?: unknown;
};

export type IntegratorOutput = {
  prUrl: string;
  branch: string;
  prNumber: number;
};

// ─── PR find-or-create (M4 — own idempotent list→filter→create, public seam) ──

type PrListEntry = { number: number; url: string; baseRefName: string };

function findOrCreatePr(
  ownerRepo: string,
  branch: string,
  base: string,
  title: string,
  execGh: ExecGhFn,
): { prUrl: string; prNumber: number } | IntegratorBlocked {
  const raw = execGh([
    'pr',
    'list',
    '--repo',
    ownerRepo,
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'number,url,baseRefName',
  ]);

  let entries: PrListEntry[];
  try {
    entries = JSON.parse(raw) as PrListEntry[];
  } catch {
    throw new Error(`gh pr list returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const matching = entries.filter((p) => p.baseRefName === base);

  if (matching.length === 1) {
    const pr = matching[0];
    if (!pr) throw new Error('unexpected empty match');
    return { prUrl: pr.url, prNumber: pr.number };
  }

  if (matching.length > 1) {
    const candidates = matching.map((p) => `#${p.number}`).join(', ');
    return {
      needsHuman: true,
      lesson: `Ambiguous: ${matching.length} open PRs for branch "${branch}" targeting "${base}" in ${ownerRepo} — candidates ${candidates} — manual review needed`,
    };
  }

  // 0 matches — create
  const createOut = execGh([
    'pr',
    'create',
    '--repo',
    ownerRepo,
    '--draft',
    '--base',
    base,
    '--head',
    branch,
    '--title',
    title,
    '--body',
    '',
  ]);

  // gh pr create prints the PR url on stdout
  const createdUrl = createOut.trim();

  // Fetch back number from the URL
  const viewRaw = execGh([
    'pr',
    'view',
    '--repo',
    ownerRepo,
    branch,
    '--json',
    'number,url',
  ]);
  let viewData: { number: number; url: string };
  try {
    viewData = JSON.parse(viewRaw) as { number: number; url: string };
  } catch {
    // gh pr view returned non-JSON after create — cannot determine real PR url/number.
    // A live integrator must NEVER emit a stub:// url; surface as needsHuman for human review.
    return {
      needsHuman: true,
      lesson:
        `gh pr view returned non-JSON after create (url=${createdUrl || 'empty'}); ` +
        'check if the PR was created and update the run manually',
    };
  }
  return { prUrl: viewData.url, prNumber: viewData.number };
}

// ─── Preflight (B5+B7) ────────────────────────────────────────────────────────

/**
 * preflightLive — clean check + base freshness, evaluated ONCE as a memoized DBOS step.
 * Only called on live runs; script/stub runs skip this entirely.
 *
 * 1. git fetch origin <base>   (idempotent — the only mutation)
 * 2. git status --porcelain    → non-empty → block (repo not clean)
 * 3. Verify base branch runs are exactly on origin/<base>, while feature branch runs
 *    are based on origin/<base> → mismatch → block
 *
 * Returns { ok: true } when the repo is clean and based on fresh origin/<base>.
 * Returns IntegratorBlocked on ANY failure — no throw, so DBOS does NOT retry.
 */
export async function preflightLive(
  taskId: string,
  base: string,
  deps: Omit<IntegratorDeps, 'execGh'>,
): Promise<{ ok: true } | IntegratorBlocked> {
  const { execGit, resolveTaskCwd } = deps;
  const cwd = await resolveTaskCwd(taskId);

  // 1. Fetch (only mutation; idempotent; ignore errors — fetch failure handled as mismatch)
  try {
    execGit(['fetch', 'origin', base], cwd);
  } catch (err) {
    return {
      needsHuman: true,
      lesson: `live preflight: git fetch origin ${base} failed — base branch may not exist on remote: ${String(err)}`,
    };
  }

  // 2. Clean check
  const porcelain = execGit(['status', '--porcelain'], cwd).trim();
  if (porcelain !== '') {
    const lineCount = porcelain.split('\n').length;
    return {
      needsHuman: true,
      lesson: `target repo ${cwd} is not clean (${lineCount} uncommitted change${lineCount === 1 ? '' : 's'}); commit/stash and retry --live`,
    };
  }

  // 3. Base freshness:
  //    - base branch itself must exactly match origin/<base>
  //    - feature branches are valid when origin/<base> is an ancestor of HEAD
  let headBranch: string;
  let headSha: string;
  let originSha: string;

  try {
    headBranch = execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
    headSha = execGit(['rev-parse', 'HEAD'], cwd).trim();
    originSha = execGit(['rev-parse', `origin/${base}`], cwd).trim();
  } catch (err) {
    return {
      needsHuman: true,
      lesson: `live preflight: cannot verify base freshness — ${String(err)}`,
    };
  }

  if (headBranch === base && headSha !== originSha) {
    // The clean base branch isn't at origin/<base>. SELF-HEAL instead of dead-ending: a sibling run
    // merging advances origin/<base>, and the old hard block forced a manual `git pull` + re-run for
    // every other in-flight run (slice 142 / dogfood). The tree is already clean (step 2), so if the
    // base is simply BEHIND (HEAD is an ancestor of origin/<base>) we fast-forward it — exactly what
    // `git pull --ff-only` does, and harmless for worktree-isolated runs (they re-cut from origin anyway).
    // Only a genuinely DIVERGED base (local commits absent from the remote) still blocks for a human.
    let behind = false;
    try {
      execGit(['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`], cwd);
      behind = true;
    } catch {
      behind = false; // not an ancestor → diverged (or unrelated)
    }
    if (!behind) {
      return {
        needsHuman: true,
        lesson:
          `target repo base branch ${base} has DIVERGED from origin/${base} ` +
          `(HEAD=${headSha.slice(0, 8)} has local commits absent from origin/${base}@${originSha.slice(0, 8)}); ` +
          `reconcile manually, then retry --live`,
      };
    }
    try {
      execGit(['merge', '--ff-only', `origin/${base}`], cwd); // clean + ancestor → cannot conflict
    } catch (err) {
      return {
        needsHuman: true,
        lesson: `live preflight: fast-forward of ${base} to origin/${base} failed — ${String(err)}; pull ${base} manually and retry --live`,
      };
    }
  }

  if (headBranch !== base) {
    try {
      execGit(['merge-base', '--is-ancestor', `origin/${base}`, 'HEAD'], cwd);
    } catch {
      return {
        needsHuman: true,
        lesson:
          `target repo branch is not based on fresh origin/${base} ` +
          `(HEAD=${headBranch}@${headSha.slice(0, 8)}, expected origin/${base}@${originSha.slice(0, 8)} as ancestor); ` +
          `rebase or merge origin/${base}, then retry --live`,
      };
    }
  }

  return { ok: true };
}

// ─── STUB integrator (script only) ───────────────────────────────────────────

/**
 * stubIntegrate — PURE, zero side effects; returns a placeholder result.
 * Used by `script` mode (default + --stub). Makes NO execGit/execGh calls.
 */
export function stubIntegrate(input: IntegratorInput): IntegratorOutput {
  return {
    prUrl: 'stub://pr/placeholder',
    branch: `feat/${input.taskId}-stub`,
    prNumber: 0,
  };
}

// ─── REAL integrator (live only) ─────────────────────────────────────────────

/**
 * integrate — REAL integrator (live only).
 * Replay-safe: branch create-if-absent (no clobber); commit only if staged diff;
 * push + find-or-create PR even if commit already happened (ahead guard).
 */
export async function integrate(
  input: IntegratorInput,
  deps: IntegratorDeps,
): Promise<IntegratorOutput | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  // Resolve the run's ISOLATED worktree (plan 0017) — it is already checked out on `branch`, so the
  // branchExists→switch path below is a no-op and the dirty-tree `switch -c origin/<base>` (which
  // failed when the base checkout carried prior-run changes) is never taken.
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title);

  // 1. Derive owner/repo
  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  // 2. Fetch base
  git(['fetch', 'origin', input.base], cwd);

  // 3. Branch create-if-absent; never clobber a prior commit
  if (branchExists(git, cwd, branch)) {
    git(['switch', branch], cwd);
  } else {
    git(['switch', '-c', branch, `origin/${input.base}`], cwd);
  }

  // 4. Stage all changes (safe: clean-repo precondition from preflight)
  git(['add', '-A'], cwd);

  // 5. Commit decision (B4 replay safety)
  let hasStagedDiff: boolean;
  try {
    git(['diff', '--cached', '--quiet'], cwd);
    hasStagedDiff = false; // exit 0 → nothing staged
  } catch {
    hasStagedDiff = true; // exit 1 → staged diff present
  }

  if (hasStagedDiff) {
    // Commit — NO Co-Authored-By, NO summary footer (MEMORY)
    const commitMsg = `feat: ${input.title}`;
    git(['commit', '-m', commitMsg], cwd);
  } else {
    // No staged diff — check if branch is ahead of origin/<base>
    const ahead = countAhead(git, cwd, branch, input.base);
    if (ahead === 0) {
      // Nothing to integrate — no commit, not ahead
      return {
        needsHuman: true,
        lesson: 'nothing to integrate — no staged changes and branch is not ahead of origin/' + input.base,
      };
    }
    // Ahead but no staged diff → commit happened on a prior attempt; fall through to push
  }

  // 6. Push (idempotent — no force)
  git(['push', '-u', 'origin', branch], cwd);

  // 7. Find-or-create PR
  const prResult = findOrCreatePr(ownerRepo, branch, input.base, input.title, gh);
  if ('needsHuman' in prResult) return prResult;

  return { prUrl: prResult.prUrl, branch, prNumber: prResult.prNumber };
}

// ─── confirmMerge (script:confirmMerge) — gate worktree cleanup on a real merge ──

export type ConfirmMergeOutput = {
  merged: true;
  prNumber: number;
  prUrl: string;
};

/** PR view shape for the merge decision. NOTE: gh has NO `merged` JSON field — `state` is the source
 *  of truth (OPEN | MERGED | CLOSED). Requesting `--json merged` errors ("Unknown JSON field").
 *  `isDraft` matters because the integrator opens PRs as DRAFT, and `gh pr merge` refuses a draft. */
type PrMergeView = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
};

/**
 * confirmMerge — REAL (live only). Ensures the run's PR is actually merged before the run reaches its
 * success terminal (so the worktree, released on `succeeded`, is cleaned only once the branch is in the
 * base — truly disposable). Idempotent + replay-safe:
 *
 *  1. `gh pr view` the run's branch. Already `merged` (a human merged it) → succeed.
 *  2. Not merged + OPEN + `mergeStateStatus === CLEAN` (CI green, no conflicts) → `gh pr merge --squash
 *     --delete-branch`, then re-view to CONFIRM merged → succeed; otherwise block.
 *  3. Not mergeable (not OPEN, or not CLEAN — red CI / conflicts / blocked) → block (needsHuman), which
 *     routes to a `blocked` terminal and KEEPS the worktree for rework.
 *
 * Merge method is `--squash` by default; node-level parameterization (method/policy) is a deferred
 * follow-up (run-time node params).
 */
export async function confirmMerge(
  input: IntegratorInput,
  deps: IntegratorDeps,
): Promise<ConfirmMergeOutput | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  const view = (): PrMergeView => {
    const raw = gh(['pr', 'view', branch, '--repo', ownerRepo, '--json', 'number,url,state,isDraft,mergeStateStatus']);
    try {
      return JSON.parse(raw) as PrMergeView;
    } catch {
      throw new Error(`gh pr view returned non-JSON for ${branch}: ${raw.slice(0, 200)}`);
    }
  };

  const pr = view();
  if (pr.state === 'MERGED') return { merged: true, prNumber: pr.number, prUrl: pr.url };

  if (pr.state !== 'OPEN') {
    return { needsHuman: true, lesson: `PR #${pr.number} is ${pr.state} (not OPEN) and not merged — resolve manually` };
  }
  // Only auto-merge a CLEAN PR (CI green, no conflicts). Other states (BLOCKED/DIRTY/UNSTABLE/BEHIND…)
  // require a human — block and keep the worktree for rework.
  if (pr.mergeStateStatus !== 'CLEAN') {
    return {
      needsHuman: true,
      lesson:
        `PR #${pr.number} is not auto-mergeable (mergeStateStatus=${pr.mergeStateStatus}) — CI not green, ` +
        `conflicts, or required reviews pending; merge it manually (or fix + re-run) then cleanup`,
    };
  }

  // The integrator opens the PR as a DRAFT (human review at the merge gate); `gh pr merge` refuses a
  // draft, so mark it ready first (the approved merge gate IS that review). Idempotent: a no-op once ready.
  if (pr.isDraft) {
    gh(['pr', 'ready', branch, '--repo', ownerRepo]);
  }

  // Merge (squash) — idempotent: a replay re-views first (step 1) and short-circuits on state MERGED.
  gh(['pr', 'merge', branch, '--repo', ownerRepo, '--squash', '--delete-branch']);

  const after = view();
  if (after.state === 'MERGED') return { merged: true, prNumber: after.number, prUrl: after.url };
  return { needsHuman: true, lesson: `PR #${after.number} merge did not take effect (state=${after.state}) — verify manually` };
}

// ─── pollPr (script:pollPr) — observe + classify PR feedback (plan 0018) ──────

/** One failing CI check carried in prFeedback (name + conclusion + the run details link). */
export type CiFailure = { name: string; conclusion: string; detailsUrl?: string };

/** One unresolved review thread carried in prFeedback (the GraphQL node id is the resolve handle). */
export type PrReviewThread = { threadId: string; path?: string; line?: number; author?: string; body: string };

/** The classified feedback `pollPr` produces (the 0016 dataflow output consumed downstream). */
export type PrFeedback = {
  /** null when no PR could be identified (error paths) — never the invalid sentinel 0 (GitHub PRs start at 1). */
  prNumber: number | null;
  headSha: string;
  /** review_changes (unresolved threads) > ci_changes (failing checks) > clean (nothing actionable). */
  verdict: 'review_changes' | 'ci_changes' | 'clean';
  ciFailures: CiFailure[];
  reviewThreads: PrReviewThread[];
};

/** Default polling bounds — pr-readiness parity (20 polls × 30s), overridable via env so the e2e suite
 *  doesn't real-sleep; also injectable (deps.maxPolls/pollIntervalMs) so unit tests run instantly. */
function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Injectable timing + collector seam so the unit tests drive pollPr without real gh/sleep. */
export type PollPrDeps = IntegratorDeps & {
  /** Resolve PR readiness (defaults to the live `collectPrReadiness`). */
  collect?: (repo: string, branch: string, base: string, execGh: ExecGhFn) => Promise<PollPrReadiness>;
  /** Sleep between polls (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Max poll attempts before a pending block (defaults to {@link POLL_PR_MAX_POLLS}). */
  maxPolls?: number;
  /** Inter-poll interval in ms (defaults to {@link POLL_PR_INTERVAL_MS}). */
  pollIntervalMs?: number;
  /** Bounded grace polls, AFTER CI goes green + the PR is readied, to let review threads surface
   *  before declaring clean (slice 142). 0 disables the wait. Defaults to REVO_POLL_PR_REVIEW_GRACE_POLLS. */
  reviewGracePolls?: number;
};

/** The slice of `collectPrReadiness` pollPr reads — CI terminal/pass/fail + unresolved review threads. */
export type PollPrReadiness = {
  pr: { number: number | null; headSha: string };
  checks: { pending: string[]; fail: string[]; list: Array<{ name: string; result: string }> };
  reviewThreads: { items: ReviewThread[] };
};

function defaultCollect(repo: string, branch: string, base: string, execGh: ExecGhFn): Promise<PollPrReadiness> {
  // pollPr classifies by CI checks + unresolved review THREADS only — it does not read the PR comment
  // feed, so suppress the `api repos/.../{reviews,comments}` calls (`includeComments: false`). Those
  // extra calls are pure overhead here and the review-thread query already carries the actionable
  // feedback the loop acts on.
  return collectPrReadiness({ repo, headBranch: branch, baseBranch: base, includeReviewThreads: true, includeComments: false }, execGh).then(
    (r): PollPrReadiness => ({
      pr: { number: r.pr.number, headSha: r.pr.headSha },
      checks: { pending: r.checks.pending, fail: r.checks.fail, list: r.checks.list },
      reviewThreads: { items: r.reviewThreads.items },
    }),
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * pollPr — REAL (live only). Polls `collectPrReadiness` until CI is terminal (no pending checks) or a
 * timeout, then classifies the feedback by TYPE (plan 0018): unresolved review threads → review_changes;
 * else failing checks → ci_changes; else clean. A timeout with checks still pending → block (human).
 * Replay-safe at the DBOS-step boundary (memoized result), idempotent (read-only gh).
 */
export async function pollPr(
  input: IntegratorInput,
  deps: PollPrDeps,
): Promise<PrFeedback | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const collect = deps.collect ?? defaultCollect;
  const sleep = deps.sleep ?? defaultSleep;
  // Read env at CALL time (not module load) so the e2e harness can shrink the poll budget regardless
  // of import order; prod default stays 20 × 30s.
  const maxPolls = deps.maxPolls ?? envInt('REVO_POLL_PR_MAX_POLLS', 20);
  const intervalMs = deps.pollIntervalMs ?? envInt('REVO_POLL_PR_INTERVAL_MS', 30_000);

  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  let readiness: PollPrReadiness | undefined;
  for (let i = 0; i < maxPolls; i++) {
    readiness = await collect(ownerRepo, branch, input.base, gh);
    // Terminal once nothing is pending and at least one check has registered (matches pr-readiness).
    if (readiness.checks.pending.length === 0 && readiness.checks.list.length > 0) break;
    readiness = undefined;
    if (i < maxPolls - 1) await sleep(intervalMs);
  }

  if (!readiness) {
    return {
      needsHuman: true,
      lesson: `pollPr timed out after ${maxPolls} polls — CI checks still pending or none registered for ${branch}`,
    };
  }

  // `settled` is the CI-terminal readiness (defined past the guard); the review-grace loop may refresh it.
  let settled: PollPrReadiness = readiness;

  // CI failures come from the CI-terminal snapshot (terminal → won't change under us).
  const ciFailures: CiFailure[] = settled.checks.list
    .filter((c) => settled.checks.fail.includes(c.name))
    .map((c) => ({ name: c.name, conclusion: c.result }));

  // CI green → flip the PR draft→ready so CodeRabbit / human reviewers actually engage. They SKIP
  // draft PRs, which silently bypassed the entire review loop (the PR was readied only at confirmMerge,
  // i.e. after the merge gate) — slice 142. Then wait a BOUNDED grace for review threads to surface
  // before declaring clean, so we don't merge-gate a millisecond before CodeRabbit posts. We never
  // BLOCK on a review arriving: the human merge gate is the backstop, so an absent / rate-limited
  // reviewer falls through to it rather than deadlocking the run. CI-red stays draft (don't request
  // review of broken code) and routes to ci_changes for a fix first.
  if (ciFailures.length === 0) {
    try {
      gh(['pr', 'ready', branch, '--repo', ownerRepo]);
    } catch {
      // already ready / nothing to ready — idempotent best-effort
    }
    const reviewGracePolls = deps.reviewGracePolls ?? envInt('REVO_POLL_PR_REVIEW_GRACE_POLLS', 4);
    for (let i = 0; i < reviewGracePolls && settled.reviewThreads.items.length === 0; i++) {
      await sleep(intervalMs);
      settled = await collect(ownerRepo, branch, input.base, gh);
    }
  }

  const reviewThreads: PrReviewThread[] = settled.reviewThreads.items.map((t) => ({
    threadId: t.id,
    path: t.path,
    line: t.line,
    author: t.author,
    body: t.body,
  }));

  // Decision order (plan 0018): review threads first, then CI, else clean.
  const verdict: PrFeedback['verdict'] =
    reviewThreads.length > 0 ? 'review_changes' : ciFailures.length > 0 ? 'ci_changes' : 'clean';

  return {
    prNumber: settled.pr.number ?? null,
    headSha: settled.pr.headSha,
    verdict,
    ciFailures,
    reviewThreads,
  };
}

// ─── respondThreads (script:respondThreads) — reply + resolve (plan 0018) ─────

/** One triage item the analyst produced — the per-thread decision + the reply to post. */
export type TriageItem = {
  threadId: string;
  decision: 'fix' | 'wontfix' | 'question';
  guidance?: string;
  replyText?: string;
};

/** The triage object consumed by respondThreads (the analyst's `triage` output, 0016 dataflow). */
export type Triage = { items: TriageItem[]; ciGuidance?: string; needsHuman?: boolean };

export type RespondThreadsOutput = { replied: number; resolved: number };

const TRIAGE_DECISIONS = new Set(['fix', 'wontfix', 'question']);

/** Coerce the analyst's (LLM-produced, untrusted-shape) triage output to a Triage, dropping malformed
 *  items so respondThreads never throws on a null/garbled entry (CodeRabbit). */
export function asTriage(value: unknown): Triage {
  if (value === null || typeof value !== 'object') return { items: [] };
  const raw = (value as { items?: unknown }).items;
  const items: TriageItem[] = Array.isArray(raw)
    ? raw.filter(
        (it): it is TriageItem =>
          it !== null &&
          typeof it === 'object' &&
          typeof (it as { threadId?: unknown }).threadId === 'string' &&
          TRIAGE_DECISIONS.has((it as { decision?: unknown }).decision as string),
      )
    : [];
  return { items };
}

/**
 * respondThreads — REAL (live only). For each triaged thread we acted on (decision fix OR wontfix —
 * plan 0018 decision #2), reply in the thread then resolve it, via the gh-pinned GraphQL API
 * (`addPullRequestReviewThreadReply` then `resolveReviewThread`). Question items are skipped (they go to
 * the question gate, not auto-resolved). Idempotent: resolving an already-resolved thread is a no-op for
 * the loop (a reopened/new comment is caught by the next pollPr).
 */
export async function respondThreads(
  triage: Triage,
  deps: Pick<IntegratorDeps, 'execGh'>,
): Promise<RespondThreadsOutput> {
  const { execGh: gh } = deps;
  let replied = 0;
  let resolved = 0;
  for (const item of triage.items) {
    if (item.decision !== 'fix' && item.decision !== 'wontfix') continue; // skip questions
    const body = item.replyText ?? (item.decision === 'wontfix' ? 'Acknowledged; not changing.' : 'Addressed.');
    gh([
      'api', 'graphql',
      '-f', 'query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){clientMutationId}}',
      '-f', `id=${item.threadId}`,
      '-f', `body=${body}`,
    ]);
    replied++;
    gh([
      'api', 'graphql',
      '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}',
      '-f', `id=${item.threadId}`,
    ]);
    resolved++;
  }
  return { replied, resolved };
}

// ─── IntegratorService ─────────────────────────────────────────────────────────

/** Default execGit implementation wrapping execFileSync with a resolved absolute path. */
function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync(gitAbsPath(), args, { encoding: 'utf8', cwd, timeout: 60_000 });
}

/**
 * IntegratorService — @Injectable wrapper over integrate / stubIntegrate / preflightLive.
 * Exposes bound arrow properties so they survive being passed to registerStep unbound.
 * DBOS-SEALED: zero @dbos-inc imports; PipelineService registers these as steps.
 */
@Injectable()
export class IntegratorService {
  private readonly deps: Omit<IntegratorDeps, 'execGh'>;

  constructor(@Inject(RunService) private readonly runService: RunService) {
    // execGh is resolved per-run inside runIntegrate (fail-loud on an unresolved pinned identity),
    // so it is NOT built here — only the git + cwd deps are stable at construction.
    this.deps = {
      execGit: defaultExecGit,
      resolveTaskCwd: this.runService.makeResolveTaskCwd(),
      resolveRunCwd: this.runService.makeResolveRunCwd(),
    };
  }

  /**
   * Real integrator — live path. Arrow property: safe to pass unbound to registerStep.
   *
   * 0008 #1 (fail-loud, 2026-06-12 dogfood): resolve the PINNED gh identity first. If its token
   * cannot be resolved we REFUSE to fall back to the ambient gh account (which would open the PR
   * as the wrong user) and block as needsHuman instead. Only on success do we run the integrator
   * with the pinned execGh.
   */
  runIntegrate = (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[integrator] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    console.log(`[integrator] gh pinned to account '${resolveGhAccount()}' (GH_TOKEN, not ambient)`);
    return integrate(input, { ...this.deps, execGh: pinned.execGh });
  };

  /** Stub integrator — script path; zero external effects. */
  runStub = (input: IntegratorInput): IntegratorOutput => {
    return stubIntegrate(input);
  };

  /**
   * Real confirm-merge — live path. Same fail-loud pinned-gh handling as runIntegrate: refuse the
   * ambient account, block if the pinned identity cannot be resolved.
   */
  runConfirmMerge = (input: IntegratorInput): Promise<ConfirmMergeOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[confirm-merge] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return confirmMerge(input, { ...this.deps, execGh: pinned.execGh });
  };

  /** Stub confirm-merge — script path; zero external effects (treats the stub PR as merged). */
  runConfirmStub = (input: IntegratorInput): ConfirmMergeOutput => {
    return { merged: true, prNumber: 0, prUrl: `stub://pr/${input.taskId}/merged` };
  };

  /** Live preflight — clean check + base invariant. Arrow property for safe unbound registration. */
  runPreflight = (taskId: string, base: string): Promise<{ ok: true } | IntegratorBlocked> => {
    return preflightLive(taskId, base, this.deps);
  };

  /**
   * Real pollPr — live path. Same fail-loud pinned-gh handling as runIntegrate (the review/CI poll reads
   * the PR via the pinned account, never the ambient one). Blocks if the pinned identity is unresolved.
   */
  runPollPr = (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[poll-pr] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return pollPr(input, { ...this.deps, execGh: pinned.execGh });
  };

  /** Stub pollPr — script path; zero external effects (reports a clean PR so the loop converges to merge). */
  runPollStub = (_input: IntegratorInput): PrFeedback => {
    return { prNumber: null, headSha: 'stub', verdict: 'clean', ciFailures: [], reviewThreads: [] };
  };

  /**
   * Real respondThreads — live path. Same fail-loud pinned-gh handling: refuse the ambient account.
   * The consumed `triage` rides in IntegratorInput.triage (hydrated by the adapter from run_outputs).
   */
  runRespondThreads = (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[respond-threads] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return respondThreads(asTriage(input.triage), { execGh: pinned.execGh });
  };

  /** Stub respondThreads — script path; zero external effects (no threads to reply/resolve). */
  runRespondStub = (_input: IntegratorInput): RespondThreadsOutput => {
    return { replied: 0, resolved: 0 };
  };
}
