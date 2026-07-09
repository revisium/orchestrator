












import { Inject, Injectable } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';
import {
  collectPrReadiness,
  fetchRequiredCheckNames,
  GITHUB_CHECK_ROLLUP_UNAVAILABLE,
  type PrReadinessNextAction,
  type PrReadinessResult,
  type PrReadinessVerdict,
  type ReviewThread,
} from '../poller/pr-readiness-core.js';
import type { MergeOverrideAudit } from '../control-plane/merge-override-audit.js';
import { RunService } from '../revisium/run.service.js';
import {
  hasClosingIssueReference,
  hasIssueRefToken,
  issueBodyWithClosingReference,
  issueRefTag,
  type IssueAction,
  type IssueRef,
} from '../run/issue-ref.js';
import { redactTokens, resolvePinnedGh } from './gh-identity.js';
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
  githubAccount?: string;
  issueRef?: IssueRef;
  issueAction?: IssueAction;

  change?: ProducedChangeArtifact;

  triage?: unknown;
  gateResolution?: unknown;

  mergeReadiness?: { headSha: string; override?: { accepted?: boolean } };
};

export type IntegratorOutput = {
  prUrl: string;
  branch: string;
  prNumber: number;
  issueRef?: IssueRef;
  headSha?: string;
  status?: 'pushed' | 'noop';
  message?: string;
  foreignPr?: true;
  prAuthor?: string;
  integratorAccount?: string;
};

type ForeignPrProvenance = Pick<IntegratorOutput, 'foreignPr' | 'prAuthor' | 'integratorAccount'>;


type PrListEntry = {
  number: number;
  url: string;
  baseRefName: string;
  headRefOid?: string;
  title?: string;
  body?: string;
  author?: string | { login?: string };
};
type PrSummary = { prUrl: string; prNumber: number; headSha?: string; title?: string; body?: string; author?: string };

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

function prAuthorLogin(author: PrListEntry['author']): string | undefined {
  if (typeof author === 'string' && author.trim().length > 0) return author.trim();
  if (author && typeof author === 'object' && typeof author.login === 'string' && author.login.trim().length > 0) {
    return author.login.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
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
      ...(prAuthorLogin(pr.author) ? { author: prAuthorLogin(pr.author) } : {}),
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
  return matchingOpenPr(ownerRepo, branch, base, execGh, 'number,url,baseRefName,headRefOid,title,body,author');
}

function foreignPrProvenance(author: string | undefined, integratorAccount: string | undefined): ForeignPrProvenance {
  if (!integratorAccount) return {};
  if (!author || author.toLowerCase() === integratorAccount.toLowerCase()) return {};
  return { foreignPr: true, prAuthor: author, integratorAccount };
}

type ProducedChangePrContext = {
  ownerRepo: string;
  branch: string;
  title: string;
  integratorAccount?: string;
  issueRef?: IssueRef;
  issueAction?: IssueAction;
  change: ProducedChangeArtifact;
  execGh: ExecGhFn;
};

function repairProducedChangePr(
  context: ProducedChangePrContext,
  existing: PrSummary,
  provenance: ForeignPrProvenance,
): void {
  if (provenance.foreignPr) return;
  repairPr(
    context.ownerRepo,
    existing.prNumber,
    context.issueRef,
    context.issueAction,
    existing.title,
    existing.body,
    issueBoundTitle(existing.title || context.title, context.issueRef, context.ownerRepo, context.issueAction),
    prBody(existing.body, context.issueRef, context.ownerRepo, context.issueAction),
    context.execGh,
  );
}

function existingProducedChangeOutput(
  context: ProducedChangePrContext,
  existing: PrSummary,
  provenance: ForeignPrProvenance,
  status: 'noop' | 'pushed',
): IntegratorOutput {
  return {
    prUrl: existing.prUrl,
    branch: context.branch,
    prNumber: existing.prNumber,
    ...(context.issueRef ? { issueRef: context.issueRef } : {}),
    headSha: context.change.headSha,
    status,
    ...(status === 'noop' ? { message: 'nothing to integrate — produced head already pushed and equals PR head' } : {}),
    ...provenance,
  };
}

function reuseExistingProducedChangePr(context: ProducedChangePrContext, existing: PrSummary): IntegratorOutput | null {
  if (existing.headSha !== context.change.headSha) return null;
  const provenance = foreignPrProvenance(existing.author, context.integratorAccount);
  repairProducedChangePr(context, existing, provenance);
  return existingProducedChangeOutput(context, existing, provenance, 'noop');
}

function updateExistingProducedChangePr(context: ProducedChangePrContext, existing: PrSummary): IntegratorOutput {
  const provenance = foreignPrProvenance(existing.author, context.integratorAccount);
  repairProducedChangePr(context, existing, provenance);
  return existingProducedChangeOutput(context, existing, provenance, 'pushed');
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
  const issueAction = resolvedIssueAction(issueRef, change.issueAction ?? input.issueAction);

  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  git(['fetch', 'origin', input.base], cwd);

  const existing = findExistingPrWithHead(ownerRepo, branch, input.base, gh);
  if (existing && 'needsHuman' in existing) return existing;
  const prContext = { ownerRepo, branch, title: input.title, integratorAccount: input.githubAccount, issueRef, issueAction, change, execGh: gh };
  if (existing) {
    const reused = reuseExistingProducedChangePr(prContext, existing);
    if (reused) return reused;
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
    return updateExistingProducedChangePr(prContext, existing);
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
  mergeable?: string;
  closingIssuesReferences?: unknown[];
};

function mergeabilityForConfirmMerge(pr: PrMergeView, overrideAccepted: boolean): 'clean' | 'blocked' | 'unknown' {
  if (!overrideAccepted) {
    return pr.mergeStateStatus === 'CLEAN' ? 'clean' : 'blocked';
  }

  const mergeable = pr.mergeable ?? (pr.mergeStateStatus === 'CLEAN' ? 'MERGEABLE' : undefined);
  return mergeSignal(pr.mergeStateStatus, mergeable);
}

function readyFailureIsBenign(message: string): boolean {
  return /not a draft|already ready(?: for review)?/i.test(message);
}

function markPrReadyForReview(input: {
  gh: ExecGhFn;
  branch: string;
  ownerRepo: string;
  prNumber: number | null;
  githubAccount?: string;
}): IntegratorBlocked | undefined {
  try {
    input.gh(['pr', 'ready', input.branch, '--repo', input.ownerRepo]);
    return undefined;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    if (readyFailureIsBenign(raw)) return undefined;
    const account = input.githubAccount ?? 'resolved-host-account';
    return {
      needsHuman: true,
      lesson:
        `failed to mark PR #${input.prNumber ?? 'unknown'} ready for review ` +
        `(githubAccount=${account}, repo=${input.ownerRepo}, branch=${input.branch}): ${redactTokens(raw || 'gh pr ready failed')}`,
    };
  }
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
    const raw = gh(['pr', 'view', branch, '--repo', ownerRepo, '--json', 'number,url,state,isDraft,mergeStateStatus,mergeable,closingIssuesReferences']);
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
  const overrideAccepted = input.mergeReadiness?.override?.accepted === true;
  const mergeability = mergeabilityForConfirmMerge(pr, overrideAccepted);
  if (mergeability !== 'clean') {
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
  if (issueAction === 'close' && input.issueRef && !hasClosingIssueReference(pr.closingIssuesReferences, input.issueRef)) {
    return {
      needsHuman: true,
      lesson: `PR #${pr.number} is expected to close ${issueRefTag(input.issueRef, ownerRepo)} but GitHub closingIssuesReferences does not include it`,
    };
  }

  if (pr.isDraft) {
    const readyFailure = markPrReadyForReview({
      gh,
      branch,
      ownerRepo,
      prNumber: pr.number,
      ...(input.githubAccount ? { githubAccount: input.githubAccount } : {}),
    });
    if (readyFailure) return readyFailure;
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

  verdict: 'review_changes' | 'ci_changes' | 'recheck' | 'clean' | 'merged' | 'closed';
  ciFailures: CiFailure[];
  reviewThreads: PrReviewThread[];
  mergeStateStatus?: string;
  mergeable?: string;
};

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}


export type PollPrDeps = IntegratorDeps & {

  collect?: PollPrCollect;

  sleep?: (ms: number) => Promise<void>;

  maxPolls?: number;

  pollIntervalMs?: number;
  reviewGracePolls?: number;
  requiredChecks?: RequiredChecksFn;
};

type PollPrCollect = (repo: string, branch: string, base: string, execGh: ExecGhFn, issueRef?: IssueRef, issueAction?: IssueAction) => Promise<PollPrReadiness>;
type RequiredChecksFn = (repo: string, prNumber: number, execGh: ExecGhFn) => Set<string>;


export type PollPrReadiness = {
  pr: { number: number | null; headSha: string };
  checks: { pending: string[]; fail: string[]; list: Array<{ name: string; result: string }> };
  reviewThreads: { items: ReviewThread[]; unresolvedCount?: number; truncated?: true };
  readinessVerdict?: PrReadinessVerdict;
  nextAction?: PrReadinessNextAction;
  evidence: string[];
  mergeStateStatus?: string;
  mergeable?: string;
  draft?: boolean;
  feedback?: PrReadinessResult['feedback'];
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
      reviewThreads: {
        items: r.reviewThreads.items,
        unresolvedCount: r.reviewThreads.unresolvedCount,
        ...(r.reviewThreads.truncated ? { truncated: true } : {}),
      },
      readinessVerdict: r.verdict,
      nextAction: r.nextAction,
      evidence: r.evidence,
      mergeStateStatus: r.pr.mergeState,
      mergeable: r.ciSummary.mergeable,
      draft: r.pr.draft,
      feedback: r.feedback,
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
    ...(readiness.mergeStateStatus !== undefined ? { mergeStateStatus: readiness.mergeStateStatus } : {}),
    ...(readiness.mergeable !== undefined ? { mergeable: readiness.mergeable } : {}),
  };
}

// UNSTABLE/HAS_HOOKS: GitHub marks a PR mergeable even when non-required checks are unsettled.
// Required-check gating is handled upstream; this quirk is intentional for advisory-only scenarios.
export function mergeSignal(mergeStateStatus: string | undefined, mergeable: string | undefined): 'clean' | 'blocked' | 'unknown' {
  const ms = (mergeStateStatus ?? '').toUpperCase();
  const mg = (mergeable ?? '').toUpperCase();
  if (mg === 'CONFLICTING' || ms === 'DIRTY' || ms === 'BLOCKED' || ms === 'BEHIND') return 'blocked';
  if (mg === 'MERGEABLE' && (ms === 'CLEAN' || ms === 'UNSTABLE' || ms === 'HAS_HOOKS')) return 'clean';
  return 'unknown';
}

export type MergeOverrideFact = {
  kind: string;
  severity: 'hard' | 'advisory';
  summary: string;
  evidence?: string;
  name?: string;
  threadId?: string;
};

export type MergeOverrideOutput = PrFeedback & {
  override: {
    accepted: boolean;
    actor: string;
    note: string;
    audit?: {
      reason: string;
      risk: string;
      verificationResponsibility: string;
      headSha: string;
    };
    source: { gate: 'mergeGate'; inboxId: string };
    facts: MergeOverrideFact[];
    replied: number;
    resolved: number;
    reason?: string;
  };
};

export type OverrideMergeDeps = IntegratorDeps & {
  collect?: PollPrCollect;
  requiredChecks?: RequiredChecksFn;
};

type MergeOverrideGate = {
  note: string;
  audit: MergeOverrideAudit;
  actor: string;
  trustedHeadSha?: string;
  source: { gate: 'mergeGate'; inboxId: string };
};

function mergeOverrideGate(input: IntegratorInput): MergeOverrideGate | IntegratorBlocked {
  const resolution = asRecord(input.gateResolution);
  const audit = asRecord(resolution?.['mergeOverrideAudit']) as MergeOverrideAudit | undefined;
  const note = nonBlank(resolution?.['note']);
  if (!resolution || !note || !audit) {
    return {
      needsHuman: true,
      lesson: 'override_merge requires a non-empty note and mergeOverrideAudit from the merge gate',
    };
  }
  const actor = nonBlank(audit.actor) ?? nonBlank(resolution['resolvedBy']) ?? 'operator';
  const trustedHeadSha = nonBlank(resolution['trustedGateHeadSha']);
  return {
    note,
    audit,
    actor,
    ...(trustedHeadSha ? { trustedHeadSha } : {}),
    source: { gate: 'mergeGate', inboxId: nonBlank(resolution['inboxId']) ?? '' },
  };
}

function prReviewThreads(readiness: PollPrReadiness): PrReviewThread[] {
  return readiness.reviewThreads.items.map((thread) => ({
    threadId: thread.id,
    path: thread.path,
    line: thread.line,
    author: thread.author,
    body: thread.body,
  }));
}

function checkFact(severity: MergeOverrideFact['severity'], kind: string, name: string, result: string): MergeOverrideFact {
  return { severity, kind, name, summary: `${name}: ${result}`, evidence: result };
}

type MergeOverrideFactBuckets = { hard: MergeOverrideFact[]; advisory: MergeOverrideFact[] };

function emptyFactBuckets(): MergeOverrideFactBuckets {
  return { hard: [], advisory: [] };
}

function pushFact(buckets: MergeOverrideFactBuckets, fact: MergeOverrideFact): void {
  buckets[fact.severity].push(fact);
}

function reviewThreadFact(thread: ReviewThread): MergeOverrideFact {
  return {
    severity: 'advisory',
    kind: 'review_thread',
    threadId: thread.id,
    summary: thread.body,
    evidence: [thread.path, thread.line].filter((item) => item !== undefined).join(':') || thread.url || thread.id,
  };
}

function feedbackEvidence(item: { evidence?: string; location?: string; author?: string; summary?: string }): string | undefined {
  return item.evidence ?? item.location ?? item.author ?? item.summary;
}

function classifyFeedbackFacts(readiness: PollPrReadiness): { hard: MergeOverrideFact[]; advisory: MergeOverrideFact[] } {
  const facts = emptyFactBuckets();
  const feedback = readiness.feedback;
  if (!feedback) return facts;

  for (const fix of feedback.developerFixes) {
    if (fix.source === 'ci' || fix.source === 'review_thread') continue;
    const fact: MergeOverrideFact = {
      severity: 'advisory',
      kind: fix.source,
      summary: fix.summary,
      evidence: feedbackEvidence(fix),
    };
    pushFact(facts, fix.source === 'human_review' ? { ...fact, severity: 'hard' } : fact);
  }
  for (const question of feedback.reviewerQuestions) {
    pushFact(facts, {
      severity: 'hard',
      kind: 'reviewer_question',
      summary: question.summary,
      evidence: feedbackEvidence(question),
    });
  }
  for (const decision of feedback.humanDecisions) {
    pushFact(facts, {
      severity: 'hard',
      kind: decision.source,
      summary: decision.summary,
    });
  }
  for (const wait of feedback.providerWait) {
    pushFact(facts, {
      severity: 'advisory',
      kind: `provider_wait:${wait.provider}`,
      summary: wait.evidence,
      evidence: wait.reason,
    });
  }
  return facts;
}

function checkStatusFact(
  check: { name: string; result: string },
  required: boolean,
  status: 'failed' | 'pending',
): MergeOverrideFact {
  const severity = required ? 'hard' : 'advisory';
  const kind = `${required ? 'required' : 'non_required'}_check_${status}`;
  return checkFact(severity, kind, check.name, check.result);
}

function pushCheckStatusFact(
  facts: MergeOverrideFactBuckets,
  check: { name: string; result: string },
  names: readonly string[],
  required: boolean,
  status: 'failed' | 'pending',
): void {
  if (!names.includes(check.name)) return;
  pushFact(facts, checkStatusFact(check, required, status));
}

function factsFromRequiredChecks(
  readiness: PollPrReadiness,
  required: ReadonlySet<string>,
): { hard: MergeOverrideFact[]; advisory: MergeOverrideFact[] } {
  const facts = emptyFactBuckets();
  for (const check of readiness.checks.list) {
    const isRequired = required.has(check.name);
    pushCheckStatusFact(facts, check, readiness.checks.fail, isRequired, 'failed');
    pushCheckStatusFact(facts, check, readiness.checks.pending, isRequired, 'pending');
  }
  if (readiness.checks.list.length === 0) {
    pushFact(facts, {
      severity: 'advisory',
      kind: 'checks_none_registered',
      summary: 'No registered checks were reported for the PR.',
      evidence: 'checks: none registered',
    });
  }
  return facts;
}

function checkRollupUnavailableFact(readiness: PollPrReadiness): MergeOverrideFact | undefined {
  const unavailable = readiness.checks.pending.includes(GITHUB_CHECK_ROLLUP_UNAVAILABLE)
    || readiness.evidence.some((item) => item.includes(GITHUB_CHECK_ROLLUP_UNAVAILABLE));
  if (!unavailable) return undefined;
  return {
    severity: 'hard',
    kind: 'check_rollup_unavailable',
    summary: 'GitHub check rollup is unavailable; override cannot distinguish pending checks from no registered checks.',
    evidence: GITHUB_CHECK_ROLLUP_UNAVAILABLE,
  };
}

function reviewThreadsIncompleteFact(readiness: PollPrReadiness): MergeOverrideFact | undefined {
  if (readiness.reviewThreads.truncated !== true) return undefined;
  return {
    severity: 'hard',
    kind: 'review_threads_incomplete',
    summary: 'Review thread data is incomplete; override cannot safely resolve every unresolved thread.',
    evidence: `unresolvedCount=${readiness.reviewThreads.unresolvedCount ?? readiness.reviewThreads.items.length}`,
  };
}

function mergeOverrideOutput(input: {
  gate: MergeOverrideGate;
  readiness?: PollPrReadiness;
  verdict: PrFeedback['verdict'];
  facts: MergeOverrideFact[];
  accepted: boolean;
  reason?: string;
  response?: RespondThreadsOutput;
  fallbackHeadSha?: string;
}): MergeOverrideOutput {
  const readiness = input.readiness;
  const evidence = [
    ...(readiness?.evidence ?? []),
    ...(readiness ? readinessEvidence(readiness) : []),
    ...input.facts.map((fact) => `${fact.severity} ${fact.kind}: ${fact.summary}`),
    input.reason,
    `PR headSha=${readiness?.pr.headSha ?? input.fallbackHeadSha ?? input.gate.audit.headSha}`,
    `overrideMerge verdict=${input.verdict}`,
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  return {
    prNumber: readiness?.pr.number ?? null,
    headSha: readiness?.pr.headSha ?? input.fallbackHeadSha ?? input.gate.audit.headSha,
    evidence,
    verdict: input.verdict,
    ciFailures: readiness ? ciFailuresFrom(readiness) : [],
    reviewThreads: readiness ? prReviewThreads(readiness) : [],
    ...(readiness?.mergeStateStatus !== undefined ? { mergeStateStatus: readiness.mergeStateStatus } : {}),
    ...(readiness?.mergeable !== undefined ? { mergeable: readiness.mergeable } : {}),
    override: {
      accepted: input.accepted,
      actor: input.gate.actor,
      note: input.gate.note,
      audit: {
        reason: input.gate.audit.reason,
        risk: input.gate.audit.risk,
        verificationResponsibility: input.gate.audit.verificationResponsibility,
        headSha: input.gate.audit.headSha,
      },
      source: input.gate.source,
      facts: input.facts,
      replied: input.response?.replied ?? 0,
      resolved: input.response?.resolved ?? 0,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  };
}

function hardMergeabilityFact(readiness: PollPrReadiness): MergeOverrideFact | undefined {
  const signal = mergeSignal(readiness.mergeStateStatus, readiness.mergeable);
  if (signal === 'clean') return undefined;
  return {
    severity: 'hard',
    kind: signal === 'blocked' ? 'mergeability_blocked' : 'mergeability_unknown',
    summary: `mergeStateStatus=${readiness.mergeStateStatus ?? ''} mergeable=${readiness.mergeable ?? ''}`,
    evidence: `mergeStateStatus=${readiness.mergeStateStatus ?? ''}; mergeable=${readiness.mergeable ?? ''}`,
  };
}

function movedHeadFact(readiness: PollPrReadiness, gate: MergeOverrideGate): MergeOverrideFact | undefined {
  const approvedHeadSha = gate.trustedHeadSha;
  if (!approvedHeadSha) {
    return {
      severity: 'hard',
      kind: 'trusted_gate_head_unavailable',
      summary: 'Trusted merge gate head is unavailable.',
      evidence: `audit=${gate.audit.headSha}; fresh=${readiness.pr.headSha}`,
    };
  }
  if (readiness.pr.headSha === approvedHeadSha) return undefined;
  return {
    severity: 'hard',
    kind: 'head_moved',
    summary: `approved head ${approvedHeadSha} no longer matches fresh head ${readiness.pr.headSha}`,
    evidence: `approved=${approvedHeadSha}; audit=${gate.audit.headSha}; fresh=${readiness.pr.headSha}`,
  };
}

function auditHeadMismatchFact(gate: MergeOverrideGate): MergeOverrideFact | undefined {
  if (!gate.trustedHeadSha) return undefined;
  if (gate.audit.headSha === gate.trustedHeadSha) return undefined;
  return {
    severity: 'hard',
    kind: 'audit_head_mismatch',
    summary: `audit head ${gate.audit.headSha} does not match trusted merge gate head ${gate.trustedHeadSha}`,
    evidence: `audit=${gate.audit.headSha}; approved=${gate.trustedHeadSha}`,
  };
}

function initialMergeOverrideHardFacts(
  readiness: PollPrReadiness,
  gate: MergeOverrideGate,
  unavailableRollup: MergeOverrideFact | undefined,
): MergeOverrideFact[] {
  return [
    readiness.draft === true ? { severity: 'hard', kind: 'draft_pr', summary: 'PR is still draft.' } : undefined,
    auditHeadMismatchFact(gate),
    movedHeadFact(readiness, gate),
    hardMergeabilityFact(readiness),
    unavailableRollup,
    reviewThreadsIncompleteFact(readiness),
  ].filter((fact): fact is MergeOverrideFact => fact !== undefined);
}

function appendFeedbackFacts(buckets: MergeOverrideFactBuckets, readiness: PollPrReadiness): void {
  for (const thread of readiness.reviewThreads.items) {
    buckets.advisory.push(reviewThreadFact(thread));
  }
  const feedbackFacts = classifyFeedbackFacts(readiness);
  buckets.hard.push(...feedbackFacts.hard);
  buckets.advisory.push(...feedbackFacts.advisory);
}

function classifyAvailableCheckFacts(
  readiness: PollPrReadiness,
  ownerRepo: string,
  execGh: ExecGhFn,
  requiredChecks: RequiredChecksFn,
): MergeOverrideFactBuckets {
  if (readiness.checks.fail.length === 0 && readiness.checks.pending.length === 0) {
    return readiness.checks.list.length === 0 ? factsFromRequiredChecks(readiness, new Set<string>()) : emptyFactBuckets();
  }

  if (readiness.pr.number === null) {
    return {
      hard: [{ severity: 'hard', kind: 'pr_number_unavailable', summary: 'Cannot classify required checks without a PR number.' }],
      advisory: [],
    };
  }

  try {
    return factsFromRequiredChecks(readiness, requiredChecks(ownerRepo, readiness.pr.number, execGh));
  } catch (err) {
    return {
      hard: [{
        severity: 'hard',
        kind: 'required_check_names_unavailable',
        summary: 'Required check names are unavailable.',
        evidence: err instanceof Error ? err.message : String(err),
      }],
      advisory: [],
    };
  }
}

async function classifyMergeOverrideFacts(
  readiness: PollPrReadiness,
  gate: MergeOverrideGate,
  ownerRepo: string,
  execGh: ExecGhFn,
  requiredChecks: RequiredChecksFn,
): Promise<{ hard: MergeOverrideFact[]; advisory: MergeOverrideFact[] }> {
  const unavailableRollup = checkRollupUnavailableFact(readiness);
  const facts: MergeOverrideFactBuckets = {
    hard: initialMergeOverrideHardFacts(readiness, gate, unavailableRollup),
    advisory: [],
  };

  if (!unavailableRollup) {
    const checkFacts = classifyAvailableCheckFacts(readiness, ownerRepo, execGh, requiredChecks);
    facts.hard.push(...checkFacts.hard);
    facts.advisory.push(...checkFacts.advisory);
  }

  appendFeedbackFacts(facts, readiness);
  return facts;
}

function overrideThreadTriage(readiness: PollPrReadiness, note: string): Triage {
  return {
    items: readiness.reviewThreads.items.map((thread) => ({
      threadId: thread.id,
      decision: 'wontfix',
      replyText: `merged by operator override: ${note}`,
    })),
  };
}

export async function overrideMerge(
  input: IntegratorInput,
  deps: OverrideMergeDeps,
): Promise<MergeOverrideOutput | IntegratorBlocked> {
  const gate = mergeOverrideGate(input);
  if ('needsHuman' in gate) return gate;

  const { execGit: git, execGh: gh, resolveRunCwd } = deps;
  const cwd = await resolveRunCwd(input.runId, input.taskId);
  const branch = branchName(input.taskId, input.title, input.issueRef);
  const ownerRepoResult = resolveOwnerRepo(git, cwd);
  if ('needsHuman' in ownerRepoResult) return ownerRepoResult;
  const { ownerRepo } = ownerRepoResult;

  let readiness: PollPrReadiness;
  try {
    readiness = await (deps.collect ?? defaultCollect)(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
  } catch (err) {
    const fact: MergeOverrideFact = {
      severity: 'hard',
      kind: 'readiness_transport_degraded',
      summary: 'Fresh override reverify could not read PR readiness.',
      evidence: err instanceof Error ? err.message : String(err),
    };
    return mergeOverrideOutput({
      gate,
      verdict: 'recheck',
      facts: [fact],
      accepted: false,
      reason: fact.summary,
    });
  }

  if (readiness.readinessVerdict === 'merged') {
    return mergeOverrideOutput({ gate, readiness, verdict: 'merged', facts: [], accepted: false, reason: 'PR already merged externally.' });
  }
  if (readiness.readinessVerdict === 'closed') {
    const fact: MergeOverrideFact = { severity: 'hard', kind: 'pr_closed_externally', summary: 'PR is closed without being merged.' };
    return mergeOverrideOutput({ gate, readiness, verdict: 'closed', facts: [fact], accepted: false, reason: fact.summary });
  }

  const facts = await classifyMergeOverrideFacts(readiness, gate, ownerRepo, gh, deps.requiredChecks ?? fetchRequiredCheckNames);
  if (facts.hard.length > 0) {
    return mergeOverrideOutput({
      gate,
      readiness,
      verdict: 'recheck',
      facts: facts.hard,
      accepted: false,
      reason: 'override_merge refused because hard blockers remain',
    });
  }

  const response = await respondThreads(overrideThreadTriage(readiness, gate.note), { execGh: gh });
  return mergeOverrideOutput({
    gate,
    readiness,
    verdict: 'clean',
    facts: facts.advisory,
    accepted: true,
    response,
  });
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
  let markedReadyForReview = false;
  for (let i = 0; i < maxPolls; i++) {
    readiness = await collect(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
    if (
      readiness.draft === true
      && readiness.readinessVerdict !== 'merged'
      && readiness.readinessVerdict !== 'closed'
      && ciFailuresFrom(readiness).length === 0
    ) {
      const readyFailure = markPrReadyForReview({
        gh,
        branch,
        ownerRepo,
        prNumber: readiness.pr.number,
        ...(input.githubAccount ? { githubAccount: input.githubAccount } : {}),
      });
      if (readyFailure) return readyFailure;
      markedReadyForReview = true;
      readiness = await collect(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
    }
    lastReadiness = readiness;
    if (readiness.checks.pending.length === 0) break;
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

  const makeTerminalFeedback = (verdict: Extract<PrFeedback['verdict'], 'merged' | 'closed'>): PrFeedback => ({
    prNumber: settled.pr.number ?? null,
    headSha: settled.pr.headSha,
    evidence: [...settled.evidence, ...readinessEvidence(settled), `PR headSha=${settled.pr.headSha}`, `pollPr verdict=${verdict}`],
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
    verdict,
    ciFailures: ciFailuresFrom(settled),
    reviewThreads: [],
    ...(settled.mergeStateStatus !== undefined ? { mergeStateStatus: settled.mergeStateStatus } : {}),
    ...(settled.mergeable !== undefined ? { mergeable: settled.mergeable } : {}),
  });

  if (settled.readinessVerdict === 'merged') return makeTerminalFeedback('merged');
  if (settled.readinessVerdict === 'closed') return makeTerminalFeedback('closed');

  const standardCheckResults = new Set('ACTION_REQUIRED CANCELLED ERROR EXPECTED FAILURE IN_PROGRESS NEUTRAL PENDING QUEUED SKIPPED STALE STARTUP_FAILURE SUCCESS TIMED_OUT UNKNOWN'.split(' '));
  const standardMergeStateStatuses = new Set('BEHIND BLOCKED CLEAN DIRTY DRAFT HAS_HOOKS UNKNOWN UNSTABLE'.split(' '));
  const standardMergeableStates = new Set('CONFLICTING MERGEABLE UNKNOWN'.split(' '));
  const addUnclassifiableState = (
    states: string[],
    label: string,
    value: string | undefined,
    known: ReadonlySet<string>,
  ): void => {
    const state = (value ?? '').trim().toUpperCase();
    if (state !== '' && !known.has(state)) states.push(`${label} ${state}`);
  };
  const unclassifiablePollState = (snapshot: PollPrReadiness): string[] => {
    const states: string[] = [];
    for (const check of snapshot.checks.list) {
      addUnclassifiableState(states, 'check result', check.result, standardCheckResults);
    }
    addUnclassifiableState(states, 'mergeStateStatus', snapshot.mergeStateStatus, standardMergeStateStatuses);
    addUnclassifiableState(states, 'mergeable', snapshot.mergeable, standardMergeableStates);
    return states;
  };
  const unclassifiableReadinessBlock = (snapshot: PollPrReadiness, states: string[]): IntegratorBlocked => ({
    needsHuman: true,
    lesson: [
      ...snapshot.evidence,
      ...readinessEvidence(snapshot),
      `pollPr unclassifiable readiness state: ${states.join(', ')}`,
      `PR headSha=${snapshot.pr.headSha}`,
    ].join('; '),
  });

  const unclassifiable = unclassifiablePollState(settled);
  if (unclassifiable.length > 0) {
    return unclassifiableReadinessBlock(settled, unclassifiable);
  }

  const initialCiFailures = ciFailuresFrom(settled);

  if (initialCiFailures.length === 0) {
    if (!markedReadyForReview) {
      const readyFailure = markPrReadyForReview({
        gh,
        branch,
        ownerRepo,
        prNumber: settled.pr.number,
        ...(input.githubAccount ? { githubAccount: input.githubAccount } : {}),
      });
      if (readyFailure) return readyFailure;
    }
    const reviewGracePolls = deps.reviewGracePolls ?? envInt('REVO_POLL_PR_REVIEW_GRACE_POLLS', 4);
    for (let i = 0; i < reviewGracePolls && settled.reviewThreads.items.length === 0; i++) {
      await sleep(intervalMs);
      settled = await collect(ownerRepo, branch, input.base, gh, input.issueRef, input.issueAction);
    }
  }

  if (settled.readinessVerdict === 'merged') return makeTerminalFeedback('merged');
  if (settled.readinessVerdict === 'closed') return makeTerminalFeedback('closed');

  const finalUnclassifiable = unclassifiablePollState(settled);
  if (finalUnclassifiable.length > 0) {
    return unclassifiableReadinessBlock(settled, finalUnclassifiable);
  }

  if (settled.checks.pending.length > 0) {
    return unsettledReadinessFeedback(
      input,
      settled,
      `pollPr found unsettled readiness after readying ${branch}: pending checks: ${settled.checks.pending.join(', ')}`,
    );
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
  let requiredCheckFetchFailure: string | undefined;
  if (ciFailures.length > 0 && settled.pr.number !== null) {
    try {
      const required = requiredChecks(ownerRepo, settled.pr.number, gh);
      if (required.size > 0) ciVerdictFailures = ciFailures.filter((f) => required.has(f.name));
    } catch (err) {
      requiredCheckFetchFailure = err instanceof Error ? err.message : String(err);
    }
  }

  const makeFeedback = (verdict: PrFeedback['verdict'], extraEvidence: string[] = []): PrFeedback => ({
    prNumber: settled.pr.number ?? null,
    headSha: settled.pr.headSha,
    evidence: [...settled.evidence, ...readinessEvidence(settled), ...extraEvidence, `PR headSha=${settled.pr.headSha}`, `pollPr verdict=${verdict}`],
    ...(input.issueRef ? { issueRef: input.issueRef } : {}),
    verdict,
    ciFailures,
    reviewThreads,
    ...(settled.mergeStateStatus !== undefined ? { mergeStateStatus: settled.mergeStateStatus } : {}),
    ...(settled.mergeable !== undefined ? { mergeable: settled.mergeable } : {}),
  });

  if (reviewThreads.length > 0 || readinessRequiresReview(settled)) return makeFeedback('review_changes');
  if (requiredCheckFetchFailure) {
    return makeFeedback('recheck', [`Required check names unavailable: ${requiredCheckFetchFailure}`]);
  }
  if (ciVerdictFailures.length > 0) return makeFeedback('ci_changes');

  const signal = mergeSignal(settled.mergeStateStatus, settled.mergeable);
  if (signal === 'blocked') {
    return {
      needsHuman: true,
      lesson: [
        ...settled.evidence,
        ...readinessEvidence(settled),
        `pollPr merge readiness blocked (mergeStateStatus=${settled.mergeStateStatus ?? ''} mergeable=${settled.mergeable ?? ''})`,
        `PR headSha=${settled.pr.headSha}`,
      ].join('; '),
    };
  }
  if (signal === 'unknown') {
    return unsettledReadinessFeedback(
      input,
      settled,
      `pollPr merge readiness unknown (mergeable=${settled.mergeable ?? 'undefined'})`,
    );
  }

  return makeFeedback('clean');
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

function questionGateResolution(value: unknown): { decision: 'fix' | 'wontfix'; note?: string } | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const outcome = (value as { outcome?: unknown }).outcome;
  if (outcome !== 'fix' && outcome !== 'wontfix') return undefined;
  const rawNote = (value as { note?: unknown }).note;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  return { decision: outcome, ...(note ? { note } : {}) };
}

function replyTextForQuestionResolution(decision: 'fix' | 'wontfix', note: string | undefined): string {
  if (decision === 'fix') return note ? `Addressed: ${note}` : 'Addressed.';
  return note ? `Won't fix: ${note}` : "Won't fix.";
}

export function triageForRespondThreads(input: Pick<IntegratorInput, 'triage' | 'gateResolution'>): Triage {
  const triage = asTriage(input.triage);
  const resolution = questionGateResolution(input.gateResolution);
  if (!resolution) return triage;
  return {
    ...triage,
    items: triage.items.map((item) =>
      item.decision === 'question'
        ? {
            ...item,
            decision: resolution.decision,
            replyText: replyTextForQuestionResolution(resolution.decision, resolution.note),
          }
        : item,
    ),
  };
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
    const pinned = resolvePinnedGh({ account: input.githubAccount });
    if ('needsHuman' in pinned) {
      console.warn(`[integrator] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    console.log(`[integrator] gh pinned to account '${pinned.account}' (GH_TOKEN, not ambient)`);
    return integrate({ ...input, githubAccount: pinned.account }, { ...this.deps, execGh: pinned.execGh });
  };


  runConfirmMerge = (input: IntegratorInput): Promise<ConfirmMergeOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh({ account: input.githubAccount });
    if ('needsHuman' in pinned) {
      console.warn(`[confirm-merge] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return confirmMerge({ ...input, githubAccount: pinned.account }, { ...this.deps, execGh: pinned.execGh });
  };


  runPreflight = (taskId: string, base: string): Promise<{ ok: true } | IntegratorBlocked> => {
    return preflightLive(taskId, base, this.deps);
  };


  runCaptureProducedChange = (input: CaptureProducedChangeInput): Promise<ProducedChangeArtifact> => {
    return captureProducedChange(input, this.deps);
  };



  runPollPr = (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
    const pinned = resolvePinnedGh({ account: input.githubAccount });
    if ('needsHuman' in pinned) {
      console.warn(`[poll-pr] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return pollPr({ ...input, githubAccount: pinned.account }, { ...this.deps, execGh: pinned.execGh });
  };


  runOverrideMerge = (input: IntegratorInput): Promise<MergeOverrideOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh({ account: input.githubAccount });
    if ('needsHuman' in pinned) {
      console.warn(`[override-merge] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return overrideMerge({ ...input, githubAccount: pinned.account }, { ...this.deps, execGh: pinned.execGh });
  };

  runRespondThreads = (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
    const pinned = resolvePinnedGh({ account: input.githubAccount });
    if ('needsHuman' in pinned) {
      console.warn(`[respond-threads] ${pinned.lesson}`);
      return Promise.resolve(pinned);
    }
    return respondThreads(triageForRespondThreads(input), { execGh: pinned.execGh });
  };
}
