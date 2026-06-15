import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * `ExecFn` for the integrator: real git, except `remote get-url origin` returns a synthetic GitHub
 * URL so the integrator can derive a parseable owner/repo without a real remote being configured.
 */
export const execGit: ExecFn = (args, cwd) => {
  if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
    return 'git@github.com:e2e/repo.git\n';
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

/** Create a throwaway bare+worktree git repo with one initial commit pushed to `origin/master`. */
export function createTargetRepo(): TargetRepo {
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
  git(worktree, ['push', '-u', 'origin', 'master']);
  return { root, worktree, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
