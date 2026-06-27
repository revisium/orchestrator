import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ExecFn } from '../../runners/integrator.js';

/** Run a real `git` command in `cwd` and return stdout. */
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// worktree → URL reported for `git remote get-url origin`. Default: a synthetic GitHub URL (so the
// integrator derives a parseable owner/repo without a real github remote). A target repo can register
// a non-github URL to exercise the "no parseable github remote" path (D8).
const reportedRemote = new Map<string, string>();

function setReportedRemote(worktree: string, url: string): void {
  reportedRemote.set(worktree, url);
  try {
    reportedRemote.set(realpathSync(worktree), url); // cwd may arrive realpath-canonicalized
  } catch {
    /* worktree exists here; ignore */
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve the synthetic origin URL for a cwd. The remote is registered against the BASE checkout, but
 * the integrator now runs in the run's linked worktree (plan 0017 — under the data dir). When the cwd
 * isn't a registered base, resolve it to its base repo via git's common dir (`<base>/.git`) and look up
 * the registration there. Default: a synthetic GitHub URL so owner/repo parsing works without a real remote.
 */
function resolveReportedRemote(cwd: string): string {
  const direct = reportedRemote.get(cwd) ?? reportedRemote.get(safeRealpath(cwd));
  if (direct) return direct;
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8', cwd, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const baseWorktree = dirname(isAbsolute(commonDir) ? commonDir : join(cwd, commonDir));
    const mapped = reportedRemote.get(baseWorktree) ?? reportedRemote.get(safeRealpath(baseWorktree));
    if (mapped) return mapped;
  } catch {
    /* not a worktree / no common dir — fall through to the default */
  }
  return 'git@github.com:e2e/repo.git';
}

/**
 * `ExecFn` for the integrator: real git, except `remote get-url origin` returns the URL registered
 * for the cwd (or its base repo when run from a linked worktree); default: a synthetic GitHub URL.
 */
export const execGit: ExecFn = (args, cwd) => {
  if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
    return `${resolveReportedRemote(cwd)}\n`;
  }
  return execFileSync('git', args, {
    encoding: 'utf8',
    cwd,
    timeout: 60_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

export type TargetRepo = {
  root: string;
  worktree: string;
  /** Remove the whole temp tree; call in a `finally`. */
  cleanup: () => void;
};

/** Target repository states for live-startup and integrator failure coverage. At most one applies. */
export type TargetRepoState = {
  /** Leave an uncommitted file so `git status --porcelain` is non-empty (preflight: "not clean"). */
  dirty?: boolean;
  /** Commit locally without pushing so the caller base branch has local-only commits (preflight: block). */
  baseAhead?: boolean;
  /** Sit on a feature branch that predates an advanced origin/master (startup must still cut a fresh worktree). */
  staleBranch?: boolean;
  /** Never push master, so `git fetch origin master` fails (preflight: base branch may not exist). */
  baseMissing?: boolean;
  /** Report a non-github origin URL, so the integrator can't parse owner/repo (integrate: needsHuman). */
  nonGithubRemote?: boolean;
};

/**
 * Create a throwaway bare+worktree git repo with one initial commit pushed to `origin/master`.
 * Pass a {@link TargetRepoState} to leave it in a state required by an e2e scenario.
 */
export function createTargetRepo(state: TargetRepoState = {}): TargetRepo {
  const root = mkdtempSync(join(tmpdir(), 'revo-e2e-target-'));
  const origin = join(root, 'origin.git');
  const worktree = join(root, 'worktree');
  git(root, ['init', '--bare', '--initial-branch=master', origin]);
  git(root, ['init', '--initial-branch=master', worktree]);
  git(worktree, ['config', 'user.name', 'Revo E2E']);
  git(worktree, ['config', 'user.email', 'revo-e2e@example.test']);
  writeFileSync(join(worktree, 'README.md'), '# e2e target\n');
  git(worktree, ['add', 'README.md']);
  git(worktree, ['commit', '-m', 'init']);
  git(worktree, ['remote', 'add', 'origin', origin]);
  if (!state.baseMissing) {
    git(worktree, ['push', '-u', 'origin', 'master']); // origin/master exists for the happy path
  }

  if (state.nonGithubRemote) {
    setReportedRemote(worktree, 'https://gitlab.example.test/owner/repo.git');
  }
  if (state.staleBranch) {
    git(worktree, ['switch', '-c', 'stale-feature']); // branch at the initial commit
    git(worktree, ['switch', 'master']);
    writeFileSync(join(worktree, 'moved.txt'), 'master advanced\n');
    git(worktree, ['add', 'moved.txt']);
    git(worktree, ['commit', '-m', 'advance master']);
    git(worktree, ['push', 'origin', 'master']); // origin/master now ahead of stale-feature
    git(worktree, ['switch', 'stale-feature']); // worktree sits on the stale branch
  } else if (state.baseAhead) {
    writeFileSync(join(worktree, 'ahead.txt'), 'local-only\n');
    git(worktree, ['add', 'ahead.txt']);
    git(worktree, ['commit', '-m', 'local-only commit (not pushed)']); // local master ahead of origin
  }
  if (state.dirty) {
    writeFileSync(join(worktree, 'dirty.txt'), 'uncommitted change\n'); // untracked → porcelain dirty
  }

  return { root, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
