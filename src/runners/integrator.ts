












import { Inject, Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';
import {
  collectPrReadiness,
  fetchRequiredCheckNames,
  type PrReadinessNextAction,
  type PrReadinessVerdict,
  type ReviewThread,
} from '../poller/pr-readiness-core.js';
import { RunService } from '../revisium/run.service.js';
import {
  hasIssueRefToken,
  issueBodyWithClosingReference,
  issueRefTag,
  type IssueAction,
  type IssueRef,
} from '../run/issue-ref.js';
import { resolveGhAccount, resolvePinnedGh } from './gh-identity.js';
import type { ExecFn, IntegratorBlocked } from './integrator-types.js';
import { gitAbsPath, branchExists, countAhead } from './integrator-git.js';
import { resolveOwnerRepo } from './integrator-remote.js';
import { branchName } from './integrator-branch-naming.js';

export { resolveExecutable } from './integrator-git.js';
export { branchName };
export { parseOwnerRepo } from './integrator-remote.js';
export type { ExecFn, IntegratorBlocked };


export type IntegratorDeps = {
  execGit: ExecFn;
  execGh: ExecGhFn;

  resolveTaskCwd: (taskId: string) => Promise<string>;
  resolveRunCwd: (runId: string, taskId: string) => Promise<string>;
};

export type ProducedChangeArtifact = {
  branch: string;
  headSha: string;
  issueRef?: IssueRef;
  issueAction?: IssueAction;
  worktreePath?: string;
  artifactRef?: string;
  prNumber?: number;
};

export type CaptureProducedChangeInput = {
  runId: string;
  taskId: string;
  title: string;
  base: string;
  nodeId: string;
  attemptId: string;
  issueRef?: IssueRef;
  issueAction?: IssueAction;
  artifactRef?: string;
};

export type CaptureProducedChangeDeps = Pick<IntegratorDeps, 'execGit' | 'resolveRunCwd'>;

export type IntegratorInput = {
  runId: string;
  taskId: string;
  title: string;
  base: string;
  issueRef?: IssueRef;
  issueAction?: IssueAction;

  change?: ProducedChangeArtifact;

  triage?: unknown;

  mergeReadiness?: { headSha: string };
};

export type IntegratorOutput = {
  prUrl: string;
  branch: string;
  prNumber: number;
  issueRef?: IssueRef;
  headSha?: string;
  status?: 'pushed' | 'noop';
  message?: string;
};


type PrListEntry = { number: number; url: string; baseRefName: string; headRefOid?: string; title?: string; body?: string };
type PrSummary = { prUrl: string; prNumber: number; headSha?: string; title?: string; body?: string };

function issueBoundTitle(title: string, issueRef?: IssueRef, ownerRepo?: string, issueAction: IssueAction = issueRef ? 'close' : 'none'): string {
  if (!issueRef || issueAction === 'none') return title;
  if (hasIssueRefToken(title, issueRef, ownerRepo)) return title;
  const tag = issueRefTag(issueRef, ownerRepo);
  return tag ? `${tag} ${title}` : title;
}

function commitMessage(title: string, issueRef?: IssueRef, ownerRepo?: string, issueAction: IssueAction = issueRef ? 'close' : 'none'): string {
  if (!issueRef || issueAction === 'none') return `feat: ${title}`;
  const tag = issueRefTag(issueRef, ownerRepo);
  return tag ? `feat: ${tag} ${title}` : `feat: ${title}`;
}

function prBody(body: string | undefined, issueRef: IssueRef | undefined, ownerRepo: string, issueAction: IssueAction | undefined): string {
  if (issueAction !== 'close') return body ?? '';
  return issueBodyWithClosingReference(body, issueRef, ownerRepo);
}

function resolvedIssueAction(issueRef: IssueRef | undefined, issueAction: IssueAction | undefined): IssueAction | undefined {
  return issueAction ?? (issueRef ? 'close' : undefined);
}

function parsePrList(raw: string): PrListEntry[] {
  try {
    return JSON.parse(raw) as PrListEntry[];
  } catch {
    throw new Error(`gh pr list returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

function matchingOpenPr(
  ownerRepo: string,
  branch: string,
  base: string,
  execGh: ExecGhFn,
  jsonFields: string,
): PrSummary | null | IntegratorBlocked {
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
    jsonFields,
  ]);

  const matching = parsePrList(raw).filter((p) => p.baseRefName === base);

  if (matching.length === 1) {
    const pr = matching[0];
    if (!pr) throw new Error('unexpected empty match');
    return {
      prUrl: pr.url,
      prNumber: pr.number,
      ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
      ...(pr.title !== undefined ? { title: pr.title } : {}),
      ...(pr.body !== undefined ? { body: pr.body } : {}),
    };
  }

  if (matching.length > 1) {
    const candidates = matching.map((p) => `#${p.number}`).join(', ');
    return {
      needsHuman: true,
      lesson: `Ambiguous: ${matching.length} open PRs for branch "${branch}" targeting "${base}" in ${ownerRepo} — candidates ${candidates} — manual review needed`,
    };
  }

  return null;
}

function createPr(
  ownerRepo: string,
  branch: string,
  base: string,
  title: string,
  issueRef: IssueRef | undefined,
  issueAction: IssueAction | undefined,
  execGh: ExecGhFn,
): PrSummary | IntegratorBlocked {
  const resolvedTitle = issueBoundTitle(title, issueRef, ownerRepo, issueAction);
  const resolvedBody = prBody(undefined, issueRef, ownerRepo, issueAction);
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
    resolvedTitle,
    '--body',
    resolvedBody,
  ]);

  const createdUrl = createOut.trim();

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
    return {
      needsHuman: true,
      lesson:
        `gh pr view returned non-JSON after create (url=${createdUrl || 'empty'}); ` +
        'check if the PR was created and update the run manually',
    };
  }
  return { prUrl: viewData.url, prNumber: viewData.number, title: resolvedTitle, body: resolvedBody };
}

function repairPr(
  ownerRepo: string,
  prNumber: number,
  issueRef: IssueRef | undefined,
  issueAction: IssueAction | undefined,
  title: string | undefined,
  body: string | undefined,
  desiredTitle: string,
  desiredBody: string,
  execGh: ExecGhFn,
): void {
  if (!issueRef && issueAction !== 'close') return;
  const args = ['pr', 'edit', String(prNumber), '--repo', ownerRepo];
  if ((title ?? '') !== desiredTitle) args.push('--title', desiredTitle);
  if ((body ?? '') !== desiredBody) args.push('--body', desiredBody);
  if (args.length > 5) execGh(args);
}

function findOrCreatePr(
  ownerRepo: string,
  branch: string,
  base: string,
  title: string,
  issueRef: IssueRef | undefined,
  issueAction: IssueAction | undefined,
  execGh: ExecGhFn,
): { prUrl: string; prNumber: number } | IntegratorBlocked {
  const existing = matchingOpenPr(ownerRepo, branch, base, execGh, 'number,url,baseRefName,title,body');
  if (existing && !('needsHuman' in existing)) {
    repairPr(
      ownerRepo,
      existing.prNumber,
      issueRef,
      issueAction,
      existing.title,
      existing.body,
      issueBoundTitle(existing.title || title, issueRef, ownerRepo, issueAction),
      prBody(existing.body, issueRef, ownerRepo, issueAction),
      execGh,
    );
    return { prUrl: existing.prUrl, prNumber: existing.prNumber };
  }
  if (existing) return existing;
  return createPr(ownerRepo, branch, base, title, issueRef, issueAction, execGh);
}

function findExistingPrWithHead(
  ownerRepo: string,
  branch: string,
  base: string,
  execGh: ExecGhFn,
): PrSummary | null | IntegratorBlocked {
  return matchingOpenPr(ownerRepo, branch, base, execGh, 'number,url,baseRefName,headRefOid,title,body');
}












export async function preflightLive(
  taskId: string,
  base: string,
  deps: Omit<IntegratorDeps, 'execGh'>,
): Promise<{ ok: true } | IntegratorBlocked> {
  const { execGit, resolveTaskCwd } = deps;
  const cwd = await resolveTaskCwd(taskId);

  try {
    execGit(['fetch', 'origin', base], cwd);
  } catch (err) {
    return {
      needsHuman: true,
      lesson: `live preflight: git fetch origin ${base} failed — base branch may not exist on remote: ${String(err)}`,
    };
  }

  const porcelain = execGit(['status', '--porcelain'], cwd).trim();
  if (porcelain !== '') {
    const lineCount = porcelain.split('\n').length;
    return {
      needsHuman: true,
      lesson: `target repo ${cwd} is not clean (${lineCount} uncommitted change${lineCount === 1 ? '' : 's'}); commit/stash and retry --live`,
    };
  }

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
      lesson: `live preflight: cannot resolve origin/${base} after fetch — ${String(err)}`,
    };
  }

  if (headBranch === base && headSha !== originSha) {
    let behind = false;
    try {
      execGit(['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`], cwd);
      behind = true;
    } catch {
      behind = false;
    }
    if (!behind) {
      return {
        needsHuman: true,
        lesson:
          `target repo base branch ${base} has local-only or diverged commits relative to origin/${base} ` +
          `(HEAD=${headSha.slice(0, 8)} has local commits absent from origin/${base}@${originSha.slice(0, 8)}); ` +
          `reconcile manually, then retry --live`,
      };
    }
  }

  return { ok: true };
}




export function stubIntegrate(input: IntegratorInput): IntegratorOutput {
  return {
    prUrl: 'stub://pr/placeholder',
    branch: `feat/${input.taskId}-stub`,
    prNumber: 0,
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
  };
}

export async function captureProducedChange(
  input: CaptureProducedChangeInput,
  deps: CaptureProducedChangeDeps,
): Promise<ProducedChangeArtifact> {
  const { execGit: git, resolveRunCwd } = deps;
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title, input.issueRef);
  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  const ownerRepo = 'needsHuman' in ownerRepoResult ? undefined : ownerRepoResult.ownerRepo;
  const issueAction = resolvedIssueAction(input.issueRef, input.issueAction);

  if (branchExists(git, cwd, branch)) {
    git(['switch', branch], cwd);
  } else {
    git(['switch', '-c', branch], cwd);
  }

  git(['add', '-A'], cwd);
  if (stagedDiffPresent(git, cwd)) {
    git(['commit', '-m', commitMessage(input.title, input.issueRef, ownerRepo, issueAction)], cwd);
  }

  const headSha = git(['rev-parse', 'HEAD'], cwd).trim();
  return {
    branch,
    headSha,
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
    ...(issueAction ? { issueAction } : {}),
    worktreePath: cwd,
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
  };
}

function stagedDiffPresent(git: ExecFn, cwd: string): boolean {
  try {
    git(['diff', '--cached', '--quiet'], cwd);
    return false;
  } catch {
    return true;
  }
}





export async function integrate(
  input: IntegratorInput,
  deps: IntegratorDeps,
): Promise<IntegratorOutput | IntegratorBlocked> {
  if (input.change) return integrateProducedChange(input, deps, input.change);

  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title, input.issueRef);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;
  const issueAction = resolvedIssueAction(input.issueRef, input.issueAction);

  git(['fetch', 'origin', input.base], cwd);

  if (branchExists(git, cwd, branch)) {
    git(['switch', branch], cwd);
  } else {
    git(['switch', '-c', branch, `origin/${input.base}`], cwd);
  }

  git(['add', '-A'], cwd);

  if (stagedDiffPresent(git, cwd)) {
    const commitMsg = commitMessage(input.title, input.issueRef, ownerRepo, issueAction);
    git(['commit', '-m', commitMsg], cwd);
  } else {
    const ahead = countAhead(git, cwd, branch, input.base);
    if (ahead === 0) {
      let lesson = 'nothing to integrate — no staged changes and branch is not ahead of origin/' + input.base;
      try {
        const baseCwd = await deps.resolveTaskCwd(input.taskId);
        const basePorcelain = git(['status', '--porcelain'], baseCwd).trim();
        if (basePorcelain !== '') {
          lesson =
            `developer produced changes but the run's worktree is empty — they appear to have been ` +
            `written OUTSIDE the worktree (the base checkout ${baseCwd} is dirty); see slice 143. ` +
            `Re-run; the agent must write under its cwd / $REVO_WORKTREE_PATH.`;
        }
      } catch {
      }
      return { needsHuman: true, lesson };
    }
  }

  git(['push', '-u', 'origin', branch], cwd);

  const prResult = findOrCreatePr(ownerRepo, branch, input.base, input.title, input.issueRef, issueAction, gh);
  if ('needsHuman' in prResult) return prResult;

  return { prUrl: prResult.prUrl, branch, prNumber: prResult.prNumber, ...(input.issueRef ? { issueRef: input.issueRef } : {}) };
}

async function integrateProducedChange(
  input: IntegratorInput,
  deps: IntegratorDeps,
  change: ProducedChangeArtifact,
): Promise<IntegratorOutput | IntegratorBlocked> {
  const { execGit: git, execGh: gh } = deps;
  const cwd = change.worktreePath ?? await deps.resolveRunCwd(input.runId, input.taskId);
  const branch = change.branch;
  const issueRef = change.issueRef ?? input.issueRef;
  const issueAction = resolvedIssueAction(issueRef, input.issueAction);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  git(['fetch', 'origin', input.base], cwd);

  const existing = findExistingPrWithHead(ownerRepo, branch, input.base, gh);
  if (existing && 'needsHuman' in existing) return existing;
  if (existing?.headSha === change.headSha) {
    repairPr(
      ownerRepo,
      existing.prNumber,
      issueRef,
      issueAction,
      existing.title,
      existing.body,
      issueBoundTitle(existing.title || input.title, issueRef, ownerRepo, issueAction),
      prBody(existing.body, issueRef, ownerRepo, issueAction),
      gh,
    );
    return {
      prUrl: existing.prUrl,
      branch,
      prNumber: existing.prNumber,
      ...(issueRef ? { issueRef } : {}),
      headSha: change.headSha,
      status: 'noop',
      message: 'nothing to integrate — produced head already pushed and equals PR head',
    };
  }

  if (!existing && countAhead(git, cwd, change.headSha, input.base) === 0) {
    return {
      needsHuman: true,
      lesson:
        `nothing to integrate — produced head ${change.headSha.slice(0, 8)} is not ahead of ` +
        `origin/${input.base} and no open PR exists`,
    };
  }

  git(['push', 'origin', `${change.headSha}:refs/heads/${branch}`], cwd);

  if (existing) {
    repairPr(
      ownerRepo,
      existing.prNumber,
      issueRef,
      issueAction,
      existing.title,
      existing.body,
      issueBoundTitle(existing.title || input.title, issueRef, ownerRepo, issueAction),
      prBody(existing.body, issueRef, ownerRepo, issueAction),
      gh,
    );
    return {
      prUrl: existing.prUrl,
      branch,
      prNumber: existing.prNumber,
      ...(issueRef ? { issueRef } : {}),
      headSha: change.headSha,
      status: 'pushed',
    };
  }

  const created = createPr(ownerRepo, branch, input.base, input.title, issueRef, issueAction, gh);
  if ('needsHuman' in created) return created;
  return {
    prUrl: created.prUrl,
    branch,
    prNumber: created.prNumber,
    ...(issueRef ? { issueRef } : {}),
    headSha: change.headSha,
    status: 'pushed',
  };
}


export type ConfirmMergeOutput = {
  merged: true;
  prNumber: number;
  prUrl: string;
  issueRef?: IssueRef;
};


type PrMergeView = {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  mergeStateStatus: string;
  closingIssuesReferences?: unknown[];
};

function hasClosingIssueReference(refs: unknown[] | undefined, issueRef: IssueRef | undefined): boolean {
  if (!issueRef || !Array.isArray(refs)) return false;
  const [owner, name] = issueRef.repo.toLowerCase().split('/');
  return refs.some((item) => {
    if (item === null || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    if (record.number !== issueRef.number) return false;
    const repository = record.repository;
    if (repository === null || typeof repository !== 'object') return false;
    const repoRecord = repository as Record<string, unknown>;
    if (typeof repoRecord.nameWithOwner === 'string') {
      return repoRecord.nameWithOwner.toLowerCase() === issueRef.repo.toLowerCase();
    }
    const repoName = typeof repoRecord.name === 'string' ? repoRecord.name.toLowerCase() : '';
    const repoOwner = repoRecord.owner;
    const ownerLogin = repoOwner && typeof repoOwner === 'object' && typeof (repoOwner as Record<string, unknown>).login === 'string'
      ? String((repoOwner as Record<string, unknown>).login).toLowerCase()
      : '';
    return ownerLogin === owner && repoName === name;
  });
}













export async function confirmMerge(
  input: IntegratorInput,
  deps: IntegratorDeps,
): Promise<ConfirmMergeOutput | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title, input.issueRef);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;
  const issueAction = resolvedIssueAction(input.issueRef, input.issueAction);

  const view = (): PrMergeView => {
    const raw = gh(['pr', 'view', branch, '--repo', ownerRepo, '--json', 'number,url,state,isDraft,mergeStateStatus,closingIssuesReferences']);
    try {
      return JSON.parse(raw) as PrMergeView;
    } catch {
      throw new Error(`gh pr view returned non-JSON for ${branch}: ${raw.slice(0, 200)}`);
    }
  };

  const pr = view();
  if (pr.state === 'MERGED') return { merged: true, prNumber: pr.number, prUrl: pr.url, ...(input.issueRef ? { issueRef: input.issueRef } : {}) };

  if (pr.state !== 'OPEN') {
    return { needsHuman: true, lesson: `PR #${pr.number} is ${pr.state} (not OPEN) and not merged — resolve manually` };
  }
  if (pr.mergeStateStatus !== 'CLEAN') {
    return {
      needsHuman: true,
      lesson:
        `PR #${pr.number} is not auto-mergeable (mergeStateStatus=${pr.mergeStateStatus}) — CI not green, ` +
        `conflicts, or required reviews pending; merge it manually (or fix + re-run) then cleanup`,
    };
  }
  const expectedHeadSha = input.mergeReadiness?.headSha.trim();
  if (!expectedHeadSha) {
    return {
      needsHuman: true,
      lesson: `PR #${pr.number} merge requires a fresh merge readiness headSha guard — re-run readiness before approving merge`,
    };
  }
  if (issueAction === 'close' && !hasClosingIssueReference(pr.closingIssuesReferences, input.issueRef)) {
    return {
      needsHuman: true,
      lesson: `PR #${pr.number} is expected to close ${issueRefTag(input.issueRef, ownerRepo)} but GitHub closingIssuesReferences does not include it`,
    };
  }

  if (pr.isDraft) {
    gh(['pr', 'ready', branch, '--repo', ownerRepo]);
  }

  try {
    gh(['pr', 'merge', branch, '--repo', ownerRepo, '--squash', '--delete-branch', '--match-head-commit', expectedHeadSha]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      needsHuman: true,
      lesson:
        `PR #${pr.number} merge was blocked by the GitHub head guard ` +
        `(expected ${expectedHeadSha}): ${message || 'merge command failed'}`,
    };
  }

  const after = view();
  if (after.state === 'MERGED') return { merged: true, prNumber: after.number, prUrl: after.url, ...(input.issueRef ? { issueRef: input.issueRef } : {}) };
  return { needsHuman: true, lesson: `PR #${after.number} merge did not take effect (state=${after.state}) — verify manually` };
}



export type CiFailure = { name: string; conclusion: string; detailsUrl?: string };


export type PrReviewThread = { threadId: string; path?: string; line?: number; author?: string; body: string };


export type PrFeedback = {

  prNumber: number | null;
  headSha: string;

  evidence: string[];
  issueRef?: IssueRef;

  verdict: 'review_changes' | 'ci_changes' | 'recheck' | 'clean';
  ciFailures: CiFailure[];
  reviewThreads: PrReviewThread[];
};

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}


export type PollPrDeps = IntegratorDeps & {

  collect?: (repo: string, branch: string, base: string, execGh: ExecGhFn, issueRef?: IssueRef, issueAction?: IssueAction) => Promise<PollPrReadiness>;

  sleep?: (ms: number) => Promise<void>;

  maxPolls?: number;

  pollIntervalMs?: number;
  reviewGracePolls?: number;
  requiredChecks?: (repo: string, prNumber: number, execGh: ExecGhFn) => Set<string>;
};


export type PollPrReadiness = {
  pr: { number: number | null; headSha: string };
  checks: { pending: string[]; fail: string[]; list: Array<{ name: string; result: string }> };
  reviewThreads: { items: ReviewThread[] };
  readinessVerdict?: PrReadinessVerdict;
  nextAction?: PrReadinessNextAction;
  evidence: string[];
};

function defaultCollect(
  repo: string,
  branch: string,
  base: string,
  execGh: ExecGhFn,
  issueRef?: IssueRef,
  issueAction?: IssueAction,
): Promise<PollPrReadiness> {
  return collectPrReadiness({ repo, headBranch: branch, baseBranch: base, issueRef, issueAction, includeReviewThreads: true, includeComments: false }, execGh).then(
    (r): PollPrReadiness => ({
      pr: { number: r.pr.number, headSha: r.pr.headSha },
      checks: { pending: r.checks.pending, fail: r.checks.fail, list: r.checks.list },
      reviewThreads: { items: r.reviewThreads.items },
      readinessVerdict: r.verdict,
      nextAction: r.nextAction,
      evidence: r.evidence,
    }),
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ciFailuresFrom(readiness: PollPrReadiness): CiFailure[] {
  return readiness.checks.list
    .filter((c) => readiness.checks.fail.includes(c.name))
    .map((c) => ({ name: c.name, conclusion: c.result }));
}

function readinessRequiresReview(readiness: PollPrReadiness): boolean {
  return readiness.readinessVerdict === 'needs_human'
    || readiness.nextAction === 'human_decision'
    || readiness.nextAction === 'reviewer_triage'
    || (readiness.nextAction === 'developer_fix' && readiness.checks.fail.length === 0);
}

function readinessRequiresHumanDecision(readiness: PollPrReadiness): boolean {
  return readiness.readinessVerdict === 'closed' || readiness.nextAction === 'human_decision';
}

function readinessEvidence(readiness: PollPrReadiness): string[] {
  return [
    readiness.readinessVerdict ? `readiness verdict=${readiness.readinessVerdict}` : undefined,
    readiness.nextAction ? `readiness nextAction=${readiness.nextAction}` : undefined,
  ].filter((item): item is string => item !== undefined);
}

function unsettledReadinessFeedback(
  input: IntegratorInput,
  readiness: PollPrReadiness,
  reason: string,
): PrFeedback {
  const reviewThreads: PrReviewThread[] = readiness.reviewThreads.items.map((t) => ({
    threadId: t.id,
    path: t.path,
    line: t.line,
    author: t.author,
    body: t.body,
  }));
  return {
    prNumber: readiness.pr.number ?? null,
    headSha: readiness.pr.headSha,
    evidence: [
      ...readiness.evidence,
      ...readinessEvidence(readiness),
      reason,
      `PR headSha=${readiness.pr.headSha}`,
      'pollPr verdict=recheck',
    ],
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
    verdict: 'recheck',
    ciFailures: ciFailuresFrom(readiness),
    reviewThreads,
  };
}





export async function pollPr(
  input: IntegratorInput,
  deps: PollPrDeps,
): Promise<PrFeedback | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const collect = deps.collect ?? defaultCollect;
  const sleep = deps.sleep ?? defaultSleep;
  const requiredChecks = deps.requiredChecks ?? fetchRequiredCheckNames;
  const maxPolls = deps.maxPolls ?? envInt('REVO_POLL_PR_MAX_POLLS', 20);
  const intervalMs = deps.pollIntervalMs ?? envInt('REVO_POLL_PR_INTERVAL_MS', 30_000);

  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title, input.issueRef);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  let readiness: PollPrReadiness | undefined;
  let lastReadiness: PollPrReadiness | undefined;
  for (let i = 0; i < maxPolls; i++) {
    readiness = await collect(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
    lastReadiness = readiness;
    if (readiness.checks.pending.length === 0 && readiness.checks.list.length > 0) break;
    readiness = undefined;
    if (i < maxPolls - 1) await sleep(intervalMs);
  }

  if (!readiness) {
    if (lastReadiness) {
      const reason = `pollPr timed out after ${maxPolls} polls; readiness still pending or no checks registered for ${branch}`;
      if (readinessRequiresHumanDecision(lastReadiness)) {
        return {
          needsHuman: true,
          lesson: [...lastReadiness.evidence, ...readinessEvidence(lastReadiness), reason, `PR headSha=${lastReadiness.pr.headSha}`].join('; '),
        };
      }
      return unsettledReadinessFeedback(
        input,
        lastReadiness,
        reason,
      );
    }
    return { needsHuman: true, lesson: `pollPr timed out after ${maxPolls} polls before reading PR readiness for ${branch}` };
  }

  let settled: PollPrReadiness = readiness;

  const initialCiFailures = ciFailuresFrom(settled);

  if (initialCiFailures.length === 0) {
    try {
      gh(['pr', 'ready', branch, '--repo', ownerRepo]);
    } catch {
    }
    const reviewGracePolls = deps.reviewGracePolls ?? envInt('REVO_POLL_PR_REVIEW_GRACE_POLLS', 4);
    for (let i = 0; i < reviewGracePolls && settled.reviewThreads.items.length === 0; i++) {
      await sleep(intervalMs);
      settled = await collect(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
    }
  }

  if (settled.checks.pending.length > 0 || settled.checks.list.length === 0) {
    const detail = settled.checks.pending.length > 0
      ? `pending checks: ${settled.checks.pending.join(', ')}`
      : 'no checks registered';
    return unsettledReadinessFeedback(input, settled, `pollPr found unsettled readiness after readying ${branch}: ${detail}`);
  }

  const reviewThreads: PrReviewThread[] = settled.reviewThreads.items.map((t) => ({
    threadId: t.id,
    path: t.path,
    line: t.line,
    author: t.author,
    body: t.body,
  }));

  const ciFailures = ciFailuresFrom(settled);

  let ciVerdictFailures = ciFailures;
  if (ciFailures.length > 0 && settled.pr.number !== null) {
    try {
      const required = requiredChecks(ownerRepo, settled.pr.number, gh);
      if (required.size > 0) ciVerdictFailures = ciFailures.filter((f) => required.has(f.name));
    } catch {
    }
  }

  const verdict: PrFeedback['verdict'] =
    reviewThreads.length > 0 || readinessRequiresReview(settled)
      ? 'review_changes'
      : ciVerdictFailures.length > 0 ? 'ci_changes' : 'clean';

  return {
    prNumber: settled.pr.number ?? null,
    headSha: settled.pr.headSha,
    evidence: [...settled.evidence, ...readinessEvidence(settled), `PR headSha=${settled.pr.headSha}`, `pollPr verdict=${verdict}`],
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
    verdict,
    ciFailures,
    reviewThreads,
  };
}



export type TriageItem = {
  threadId: string;
  decision: 'fix' | 'wontfix' | 'question';
  guidance?: string;
  replyText?: string;
};


export type Triage = { items: TriageItem[]; ciGuidance?: string; needsHuman?: boolean };

export type RespondThreadsOutput = { replied: number; resolved: number };

const TRIAGE_DECISIONS = new Set(['fix', 'wontfix', 'question']);

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






export async function respondThreads(
  triage: Triage,
  deps: Pick<IntegratorDeps, 'execGh'>,
): Promise<RespondThreadsOutput> {
  const { execGh: gh } = deps;
  let replied = 0;
  let resolved = 0;
  for (const item of triage.items) {
    if (item.decision !== 'fix' && item.decision !== 'wontfix') continue;
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



function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync(gitAbsPath(), args, { encoding: 'utf8', cwd, timeout: 60_000 });
}




@Injectable()
export class IntegratorService {
  private readonly deps: Omit<IntegratorDeps, 'execGh'>;

  constructor(@Inject(RunService) private readonly runService: RunService) {
    this.deps = {
      execGit: defaultExecGit,
      resolveTaskCwd: this.runService.makeResolveTaskCwd(),
      resolveRunCwd: this.runService.makeResolveRunCwd(),
    };
  }







  runIntegrate = (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[integrator] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    console.log(`[integrator] gh pinned to account '${resolveGhAccount()}' (GH_TOKEN, not ambient)`);
    return integrate(input, { ...this.deps, execGh: pinned.execGh });
  };


  runStub = (input: IntegratorInput): IntegratorOutput => {
    return stubIntegrate(input);
  };



  runConfirmMerge = (input: IntegratorInput): Promise<ConfirmMergeOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[confirm-merge] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return confirmMerge(input, { ...this.deps, execGh: pinned.execGh });
  };


  runConfirmStub = (input: IntegratorInput): ConfirmMergeOutput => {
    return { merged: true, prNumber: 0, prUrl: `stub://pr/${input.taskId}/merged` };
  };


  runPreflight = (taskId: string, base: string): Promise<{ ok: true } | IntegratorBlocked> => {
    return preflightLive(taskId, base, this.deps);
  };


  runCaptureProducedChange = (input: CaptureProducedChangeInput): Promise<ProducedChangeArtifact> => {
    return captureProducedChange(input, this.deps);
  };



  runPollPr = (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[poll-pr] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return pollPr(input, { ...this.deps, execGh: pinned.execGh });
  };


  runPollStub = (_input: IntegratorInput): PrFeedback => {
    return { prNumber: null, headSha: 'stub', evidence: ['stub pollPr readiness: clean'], verdict: 'clean', ciFailures: [], reviewThreads: [] };
  };



  runRespondThreads = (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh();
    if ('needsHuman' in pinned) {
      console.warn(`[respond-threads] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return respondThreads(asTriage(input.triage), { execGh: pinned.execGh });
  };


  runRespondStub = (_input: IntegratorInput): RespondThreadsOutput => {
    return { replied: 0, resolved: 0 };
  };
}
