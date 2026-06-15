import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * `ExecFn` for the integrator: real git, except `remote get-url origin` returns the URL registered
 * for the cwd (default: a synthetic GitHub URL) so owner/repo parsing works without a real remote.
 */
export const execGit: ExecFn = (args, cwd) => {
  if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
    return `${reportedRemote.get(cwd) ?? 'git@github.com:e2e/repo.git'}\n`;
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

/** Negative integrator states (each makes preflight or integrate return needsHuman). At most one applies. */
export type TargetRepoState = {
  /** Leave an uncommitted file so `git status --porcelain` is non-empty (preflight: "not clean"). */
  dirty?: boolean;
  /** Commit locally without pushing so HEAD != origin/master (preflight: base not on fresh origin). */
  baseAhead?: boolean;
  /** Sit on a feature branch that predates an advanced origin/master (preflight: not based on origin). */
  staleBranch?: boolean;
  /** Never push master, so `git fetch origin master` fails (preflight: base branch may not exist). */
  baseMissing?: boolean;
  /** Report a non-github origin URL, so the integrator can't parse owner/repo (integrate: needsHuman). */
  nonGithubRemote?: boolean;
};

/**
 * Create a throwaway bare+worktree git repo with one initial commit pushed to `origin/master`.
 * Pass a {@link TargetRepoState} to leave it in a state that fails the integrator's live preflight.
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
