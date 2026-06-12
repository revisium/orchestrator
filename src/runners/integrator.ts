/**
 * integrator.ts — deterministic, replay-safe code integrator.
 *
 * DBOS-SEALED: zero @dbos-inc imports. Registration happens in PipelineService ctor.
 *
 * Exposes:
 *   - integrate(input, deps)     — REAL integrator (live only); git/gh side effects; resumable.
 *   - stubIntegrate(input)       — STUB (script only); ZERO external effects; pure + deterministic.
 *   - preflightLive(taskId, base, deps) — LIVE PREFLIGHT; clean check + base invariant; one-shot.
 *   - IntegratorService          — @Injectable wrapper with bound arrow properties.
 *   - resolveExecutable(name)    — resolve a bare executable name to an absolute PATH entry.
 */
import { Injectable } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ExecGhFn } from '../poller/pr-readiness.js';
import { RunService } from '../revisium/run.service.js';
import { resolveGhAccount, resolvePinnedGh } from './gh-identity.js';

// ─── resolveExecutable ────────────────────────────────────────────────────────

/**
 * Resolve a bare executable name to its first absolute path on PATH.
 * Uses only node:fs + node:path — no child_process, no spawning.
 *
 * @param name  - bare executable name, e.g. "git"
 * @param pathEnv - override for PATH (defaults to process.env.PATH); injectable for tests
 * @returns absolute path to the executable
 * @throws Error if not found on PATH
 */
export function resolveExecutable(name: string, pathEnv = process.env['PATH'] ?? ''): string {
  if (!pathEnv) {
    throw new Error(`cannot resolve executable "${name}" on PATH: PATH is empty or unset`);
  }

  const dirs = pathEnv.split(delimiter);

  // On win32 also check common executable extensions; on posix the plain name suffices.
  const candidates =
    process.platform === 'win32'
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          return full;
        }
      } catch {
        // dir may be unreadable — skip silently
      }
    }
  }

  throw new Error(`cannot resolve executable "${name}" on PATH`);
}

// Lazily resolved once per process — avoids resolving on module load (safe for tests).
let _gitAbsPath: string | undefined;
function gitAbsPath(): string {
  if (_gitAbsPath === undefined) {
    _gitAbsPath = resolveExecutable('git');
  }
  return _gitAbsPath;
}

// ─── types ────────────────────────────────────────────────────────────────────

/** Synchronous executor for git commands in a given cwd. */
export type ExecFn = (args: string[], cwd: string) => string;

export type IntegratorDeps = {
  execGit: ExecFn;
  execGh: ExecGhFn;
  resolveTaskCwd: (taskId: string) => Promise<string>;
};

export type IntegratorInput = {
  runId: string;
  taskId: string;
  title: string;
  base: string;
};

export type IntegratorOutput = {
  prUrl: string;
  branch: string;
  prNumber: number;
};

export type IntegratorBlocked = {
  needsHuman: true;
  lesson: string;
};

// ─── slug helper ─────────────────────────────────────────────────────────────

const SLUG_MAX = 40;

/** Deterministic branch-name slug from title: lowercase, non-alnum runs → '-', trim/truncate. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((seg) => seg.length > 0)
    .join('-')
    .slice(0, SLUG_MAX);
}

/** Derive deterministic feature branch name from taskId + title. */
function branchName(taskId: string, title: string): string {
  const slug = slugify(title) || slugify(taskId) || 'task';
  return `feat/${taskId}-${slug}`;
}

// ─── owner/repo derivation ────────────────────────────────────────────────────

// Owner and repo: GitHub-safe chars only ([A-Za-z0-9._-]); trailing .git stripped; no trailing paths.
// Non-greedy repo segment (+?) allows the (?:\.git)? suffix to back-trim a trailing ".git".
const GITHUB_SSH_RE = /^git@github\.com:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;
const GITHUB_HTTPS_RE = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/;

export function parseOwnerRepo(remoteUrl: string): string | null {
  const ssh = GITHUB_SSH_RE.exec(remoteUrl.trim());
  if (ssh?.[1]) return ssh[1];
  const https = GITHUB_HTTPS_RE.exec(remoteUrl.trim());
  if (https?.[1]) return https[1];
  return null;
}

function resolveOwnerRepo(
  execGit: ExecFn,
  cwd: string,
): { ownerRepo: string } | IntegratorBlocked {
  let remoteUrl: string;
  try {
    remoteUrl = execGit(['remote', 'get-url', 'origin'], cwd).trim();
  } catch {
    return {
      needsHuman: true,
      lesson:
        'target repo has no parseable github remote — cannot open a PR (config gap: add a github origin remote)',
    };
  }
  const ownerRepo = parseOwnerRepo(remoteUrl);
  if (!ownerRepo) {
    return {
      needsHuman: true,
      lesson: `target repo has no parseable github remote — cannot open a PR (remote url: ${remoteUrl})`,
    };
  }
  return { ownerRepo };
}

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
 * preflightLive — clean check + base invariant, evaluated ONCE as a memoized DBOS step.
 * Only called on live runs; script/stub runs skip this entirely.
 *
 * 1. git fetch origin <base>   (idempotent — the only mutation)
 * 2. git status --porcelain    → non-empty → block (repo not clean)
 * 3. Verify HEAD === <base> AND HEAD sha === origin/<base> sha → mismatch → block
 *
 * Returns { ok: true } when the repo is clean and on fresh origin/<base>.
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

  // 3. Base invariant: HEAD branch name === base AND HEAD sha === origin/<base> sha
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
      lesson: `live preflight: cannot verify base invariant — ${String(err)}`,
    };
  }

  if (headBranch !== base || headSha !== originSha) {
    return {
      needsHuman: true,
      lesson:
        `target repo is not on a fresh origin/${base} ` +
        `(HEAD=${headBranch}@${headSha.slice(0, 8)}, expected ${base}@${originSha.slice(0, 8)}); ` +
        `checkout ${base} and pull, then retry --live`,
    };
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

/** Branch existence check — returns true if the branch exists locally. */
function branchExists(execGit: ExecFn, cwd: string, branch: string): boolean {
  try {
    execGit(['rev-parse', '--verify', branch], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count commits on branch ahead of origin/<base>.
 * Returns 0 only for expected "no upstream / unknown revision / ambiguous argument" errors
 * (these mean the branch is not ahead). Rethrows other errors so DBOS can retry transient failures.
 */
function countAhead(execGit: ExecFn, cwd: string, branch: string, base: string): number {
  try {
    const raw = execGit(['rev-list', '--count', `origin/${base}..${branch}`], cwd).trim();
    return Number.parseInt(raw, 10) || 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected: branch or upstream not yet known to git (not a transient failure).
    if (
      msg.includes('unknown revision') ||
      msg.includes('ambiguous argument') ||
      msg.includes('no upstream') ||
      msg.includes('does not have any commits yet')
    ) {
      return 0;
    }
    // Transient failure (network, lock, etc.) — rethrow so DBOS retries.
    throw err;
  }
}

/**
 * integrate — REAL integrator (live only).
 * Replay-safe: branch create-if-absent (no clobber); commit only if staged diff;
 * push + find-or-create PR even if commit already happened (ahead guard).
 */
export async function integrate(
  input: IntegratorInput,
  deps: IntegratorDeps,
): Promise<IntegratorOutput | IntegratorBlocked> {
  const { execGit: git, execGh: gh, resolveTaskCwd: resolveCwd } = deps;
  const cwd = await resolveCwd(input.taskId);
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

  constructor(private readonly runService: RunService) {
    // execGh is resolved per-run inside runIntegrate (fail-loud on an unresolved pinned identity),
    // so it is NOT built here — only the git + cwd deps are stable at construction.
    this.deps = {
      execGit: defaultExecGit,
      resolveTaskCwd: this.runService.makeResolveTaskCwd(),
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

  /** Live preflight — clean check + base invariant. Arrow property for safe unbound registration. */
  runPreflight = (taskId: string, base: string): Promise<{ ok: true } | IntegratorBlocked> => {
    return preflightLive(taskId, base, this.deps);
  };
}
