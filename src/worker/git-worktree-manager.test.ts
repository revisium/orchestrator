import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager } from './git-worktree-manager.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'revo-worktree-manager-')));
  git(['init'], root);
  git(['config', 'user.email', 'test@example.com'], root);
  git(['config', 'user.name', 'Test User'], root);
  writeFileSync(join(root, 'README.md'), 'test repo\n');
  git(['add', 'README.md'], root);
  git(['commit', '-m', 'initial'], root);
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'dependency.txt'), 'present\n');
  return root;
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

test('GitWorktreeManager creates the expected worktree and symlinks node_modules', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));

  const manager = new GitWorktreeManager();
  const worktreePath = await manager.create('step-create', root);

  assert.equal(worktreePath, join(root, '.worktrees', 'step-create'));
  assert.ok(existsSync(worktreePath), 'worktree directory exists');
  assert.equal(git(['rev-parse', '--show-toplevel'], worktreePath), worktreePath);
  const nodeModules = join(worktreePath, 'node_modules');
  assert.equal((await lstat(nodeModules)).isSymbolicLink(), true, 'node_modules is a symlink');
  assert.equal(await realpath(nodeModules), join(root, 'node_modules'));
  assert.equal(readFileSync(join(nodeModules, 'dependency.txt'), 'utf8'), 'present\n');

  await manager.release(worktreePath);
});

test('GitWorktreeManager release removes the worktree and run branch', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));

  const manager = new GitWorktreeManager();
  const stepId = 'step-release';
  const worktreePath = await manager.create(stepId, root);

  await manager.release(worktreePath);

  assert.equal(existsSync(worktreePath), false, 'worktree directory is removed');
  assert.doesNotThrow(() => git(['branch', '--list', `run/${stepId}`], root));
  assert.equal(git(['branch', '--list', `run/${stepId}`], root), '');
});

test('GitWorktreeManager release on a non-existent path does not throw', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));

  const manager = new GitWorktreeManager();
  await assert.doesNotReject(() => manager.release(join(root, '.worktrees', 'missing-step')));
});

test('GitWorktreeManager create retries by cleaning stale worktree and branch first', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));

  const manager = new GitWorktreeManager();
  const stepId = 'step-retry';
  const firstPath = await manager.create(stepId, root);
  writeFileSync(join(firstPath, 'stale.txt'), 'stale\n');

  const secondPath = await manager.create(stepId, root);

  assert.equal(secondPath, firstPath);
  assert.equal(existsSync(join(secondPath, 'stale.txt')), false, 'stale worktree content was removed');
  assert.match(git(['branch', '--list', `run/${stepId}`], root), new RegExp(`run/${stepId}$`));

  await manager.release(secondPath);
});

test('GitWorktreeManager skips node_modules symlink when source node_modules is absent', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });

  const manager = new GitWorktreeManager();
  const worktreePath = await manager.create('step-no-node-modules', root);

  assert.equal(existsSync(join(worktreePath, 'node_modules')), false);

  await manager.release(worktreePath);
});

test('GitWorktreeManager release removes a stale branch when the worktree path is already gone', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));
  const stepId = 'step-stale-branch';
  git(['branch', `run/${stepId}`], root);

  const manager = new GitWorktreeManager();
  await manager.release(join(root, '.worktrees', stepId));

  assert.equal(git(['branch', '--list', `run/${stepId}`], root), '');
});

test('GitWorktreeManager create throws when baseDir is not inside a git repository', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'revo-not-git-'));
  t.after(() => cleanup(root));

  const manager = new GitWorktreeManager();
  await assert.rejects(() => manager.create('step-outside-git', root), /not a git repository/);
});

test('GitWorktreeManager does not create a dist symlink', async (t) => {
  const root = createRepo();
  t.after(() => cleanup(root));
  mkdirSync(join(root, 'dist'));

  const manager = new GitWorktreeManager();
  const worktreePath = await manager.create('step-no-dist', root);

  assert.equal(existsSync(join(worktreePath, 'dist')), false);

  await manager.release(worktreePath);
});

test('GitWorktreeManager can create when root node_modules itself is a symlink', async (t) => {
  const root = createRepo();
  const sharedNodeModules = mkdtempSync(join(tmpdir(), 'revo-shared-node-modules-'));
  t.after(() => {
    cleanup(root);
    cleanup(sharedNodeModules);
  });
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  symlinkSync(sharedNodeModules, join(root, 'node_modules'), 'dir');

  const manager = new GitWorktreeManager();
  const worktreePath = await manager.create('step-symlinked-node-modules', root);

  assert.equal((await lstat(join(worktreePath, 'node_modules'))).isSymbolicLink(), true);

  await manager.release(worktreePath);
});
