/**
 * git-worktree-manager.test.ts — per-run worktree manager (plan 0017) against REAL git.
 *
 * Sets up a local bare remote + a base clone (no network, no gh), then exercises create-if-absent
 * idempotency, branch-from-origin/<base>, the node_modules symlink (+ graceful absence), the live
 * marker, and release.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunWorktree, releaseRunWorktree } from './git-worktree-manager.js';
import { worktreePathFor, worktreeMarkerFor } from '../control-plane/resolve-cwd.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd });
}

/** Build a bare remote + a base clone on `master` with one commit pushed. Returns paths. */
function setup(): { root: string; baseRepo: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-mgr-test-'));
  const remote = join(root, 'remote.git');
  const baseRepo = join(root, 'base');
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  git(['init', '--bare', '-b', 'master', remote], root);
  git(['clone', remote, baseRepo], root);
  git(['config', 'user.email', 't@t'], baseRepo);
  git(['config', 'user.name', 'T'], baseRepo);
  execFileSync('bash', ['-c', 'echo hello > README.md'], { cwd: baseRepo });
  git(['add', '-A'], baseRepo);
  git(['commit', '-m', 'init'], baseRepo);
  git(['push', '-u', 'origin', 'master'], baseRepo);
  return { root, baseRepo, dataDir };
}

test('createRunWorktree: creates a worktree on the feature branch off origin/<base> + marker', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({
      runId: 'run-1', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/x', dataDir,
    });
    assert.equal(worktreePath, worktreePathFor(dataDir, 'run-1'));
    assert.ok(existsSync(join(worktreePath, '.git')), 'worktree has a .git pointer');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath).trim(), 'feat/x');
    assert.ok(existsSync(join(worktreePath, 'README.md')), 'worktree carries the base content');
    assert.ok(existsSync(worktreeMarkerFor(dataDir, 'run-1')), 'live marker written');
    // The base checkout is untouched (still on master).
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], baseRepo).trim(), 'master');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunWorktree: idempotent — second call returns the same path, no throw', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const a = createRunWorktree({ runId: 'run-2', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/y', dataDir });
    const b = createRunWorktree({ runId: 'run-2', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/y', dataDir });
    assert.equal(a.worktreePath, b.worktreePath);
    assert.ok(existsSync(join(b.worktreePath, '.git')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunWorktree: symlinks node_modules when the base has one', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    mkdirSync(join(baseRepo, 'node_modules'), { recursive: true });
    const { worktreePath } = createRunWorktree({ runId: 'run-3', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/z', dataDir });
    const wtModules = join(worktreePath, 'node_modules');
    assert.ok(existsSync(wtModules), 'node_modules present in worktree');
    assert.ok(lstatSync(wtModules).isSymbolicLink(), 'node_modules is a symlink');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunWorktree: no node_modules in base → no symlink, no throw (graceful)', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({ runId: 'run-4', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/n', dataDir });
    assert.ok(!existsSync(join(worktreePath, 'node_modules')), 'no node_modules symlink');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseRunWorktree: removes the worktree + marker, idempotent', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/r', dataDir });
    assert.ok(existsSync(worktreePath));
    releaseRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, dataDir });
    assert.ok(!existsSync(worktreePath), 'worktree dir removed');
    assert.ok(!existsSync(worktreeMarkerFor(dataDir, 'run-5')), 'marker removed');
    // idempotent — releasing again is a no-op (no throw)
    releaseRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, dataDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
