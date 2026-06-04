import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorktreeManager } from './worktree-manager.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function branchName(stepId: string): string {
  return `run/${stepId}`;
}

function stepIdFromWorktreePath(worktreePath: string): string {
  return basename(worktreePath);
}

function gitRootFromExistingPath(path: string): string {
  return git(['rev-parse', '--show-toplevel'], path);
}

function gitCommonRootFromExistingPath(path: string): string {
  const commonDir = git(['rev-parse', '--git-common-dir'], path);
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(path, commonDir);
  return dirname(absoluteCommonDir);
}

function gitRootFromWorktreePath(worktreePath: string): string | null {
  if (existsSync(worktreePath)) {
    return gitCommonRootFromExistingPath(worktreePath);
  }
  const worktreesDir = dirname(worktreePath);
  if (basename(worktreesDir) !== '.worktrees') return null;
  const candidate = dirname(worktreesDir);
  return existsSync(join(candidate, '.git')) ? candidate : null;
}

function deleteBranchIfPresent(gitRoot: string, stepId: string): void {
  try {
    git(['branch', '-D', branchName(stepId)], gitRoot);
  } catch {
    // Missing branches are expected after partial cleanup or manual recovery.
  }
}

function pruneWorktrees(gitRoot: string): void {
  try {
    git(['worktree', 'prune'], gitRoot);
  } catch {
    console.warn(`Warning: git worktree prune failed in ${gitRoot}`);
  }
}

export class GitWorktreeManager implements WorktreeManager {
  async create(stepId: string, baseDir: string): Promise<string> {
    const gitRoot = gitRootFromExistingPath(baseDir);
    const worktreePath = join(gitRoot, '.worktrees', stepId);
    await this.release(worktreePath);

    git(['worktree', 'add', '-b', branchName(stepId), worktreePath, 'HEAD'], gitRoot);

    const sourceNodeModules = join(gitRoot, 'node_modules');
    const targetNodeModules = join(worktreePath, 'node_modules');
    if (existsSync(sourceNodeModules)) {
      if (existsSync(targetNodeModules) || lstatSync(targetNodeModules, { throwIfNoEntry: false }) !== undefined) {
        rmSync(targetNodeModules, { recursive: true, force: true });
      }
      symlinkSync(sourceNodeModules, targetNodeModules, 'dir');
    }

    return worktreePath;
  }

  async release(worktreePath: string): Promise<void> {
    const gitRoot = gitRootFromWorktreePath(worktreePath);
    if (gitRoot === null) return;

    if (existsSync(worktreePath)) {
      try {
        git(['worktree', 'remove', '--force', worktreePath], gitRoot);
      } catch {
        console.warn(`Warning: git worktree remove failed for ${worktreePath}; deleting directory directly`);
        rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    if (existsSync(worktreePath)) {
      console.warn(`Warning: worktree path still exists after git removal: ${worktreePath}; deleting directory directly`);
      rmSync(worktreePath, { recursive: true, force: true });
    }

    pruneWorktrees(gitRoot);
    deleteBranchIfPresent(gitRoot, stepIdFromWorktreePath(worktreePath));
  }
}
