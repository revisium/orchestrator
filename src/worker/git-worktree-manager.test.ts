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
import { writeFileSync } from 'node:fs';
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

/** Commit + push a tracked file to the base's master so it lands in fresh worktrees. */
function commitToBase(baseRepo: string, file: string, content: string): void {
  execFileSync('bash', ['-c', `printf '%s' ${JSON.stringify(content)} > ${JSON.stringify(file)}`], { cwd: baseRepo });
  git(['add', '-A'], baseRepo);
  git(['commit', '-m', `add ${file}`], baseRepo);
  git(['push', 'origin', 'master'], baseRepo);
}

test('createRunWorktree: pnpm repo → runs `pnpm install --frozen-lockfile` in the worktree, no symlink', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    commitToBase(baseRepo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    const calls: Array<{ args: string[]; cwd: string }> = [];
    const { worktreePath } = createRunWorktree({
      runId: 'run-pnpm', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/pnpm', dataDir,
      execInstall: (args, cwd) => { calls.push({ args, cwd }); },
    });
    assert.deepEqual(calls, [{ args: ['install', '--frozen-lockfile'], cwd: worktreePath }], 'pnpm install ran in the worktree');
    assert.ok(!existsSync(join(worktreePath, 'node_modules')), 'no symlink when pnpm install handled deps');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunWorktree: pnpm install failure → falls back to the node_modules symlink', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    commitToBase(baseRepo, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n");
    mkdirSync(join(baseRepo, 'node_modules'), { recursive: true });
    const { worktreePath } = createRunWorktree({
      runId: 'run-pnpm-fail', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/pnpmf', dataDir,
      execInstall: () => { throw new Error('pnpm not found'); },
    });
    assert.ok(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink(), 'fell back to symlink on install failure');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createRunWorktree: non-pnpm repo → does NOT invoke the installer (symlink path)', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    mkdirSync(join(baseRepo, 'node_modules'), { recursive: true });
    let installCalled = false;
    const { worktreePath } = createRunWorktree({
      runId: 'run-npm', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/npm', dataDir,
      execInstall: () => { installCalled = true; },
    });
    assert.equal(installCalled, false, 'no pnpm-lock.yaml → installer not invoked');
    assert.ok(lstatSync(join(worktreePath, 'node_modules')).isSymbolicLink(), 'symlinked the base node_modules');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseRunWorktree: clean worktree is removed + marker gone, idempotent', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/r', dataDir });
    assert.ok(existsSync(worktreePath));
    const result = releaseRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, dataDir });
    assert.deepEqual(result, { released: true });
    assert.ok(!existsSync(worktreePath), 'worktree dir removed');
    assert.ok(!existsSync(worktreeMarkerFor(dataDir, 'run-5')), 'marker removed');
    // idempotent — releasing again returns absent, no throw
    const result2 = releaseRunWorktree({ runId: 'run-5', baseRepoCwd: baseRepo, dataDir });
    assert.deepEqual(result2, { released: false, reason: 'absent' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseRunWorktree: dirty worktree (untracked file) is preserved by default', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({ runId: 'run-dirty', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/dirty', dataDir });
    // Write an untracked file to make the worktree dirty
    writeFileSync(join(worktreePath, 'uncommitted.txt'), 'uncommitted work\n', 'utf8');
    const result = releaseRunWorktree({ runId: 'run-dirty', baseRepoCwd: baseRepo, dataDir });
    assert.deepEqual(result, { released: false, reason: 'dirty' });
    assert.ok(existsSync(worktreePath), 'dirty worktree dir preserved');
    assert.ok(existsSync(worktreeMarkerFor(dataDir, 'run-dirty')), 'marker preserved');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseRunWorktree: force:true removes a dirty worktree', () => {
  const { root, baseRepo, dataDir } = setup();
  try {
    const { worktreePath } = createRunWorktree({ runId: 'run-force', baseRepoCwd: baseRepo, base: 'master', branch: 'feat/force', dataDir });
    writeFileSync(join(worktreePath, 'uncommitted.txt'), 'uncommitted work\n', 'utf8');
    const result = releaseRunWorktree({ runId: 'run-force', baseRepoCwd: baseRepo, dataDir, force: true });
    assert.deepEqual(result, { released: true });
    assert.ok(!existsSync(worktreePath), 'force-removed even when dirty');
    assert.ok(!existsSync(worktreeMarkerFor(dataDir, 'run-force')), 'marker removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
