/**
 * git-worktree-manager.ts — per-RUN git worktree lifecycle.
 *
 * DBOS-SEALED: zero @dbos-inc imports. Create/release are registered as memoized DBOS steps in
 * PipelineService; this module is pure git side effects + deterministic paths.
 *
 * Each LIVE run gets ONE isolated worktree at `<dataDir>/worktrees/<runId>`, checked out on the run's
 * feature branch (the SAME `feat/<taskId>-<slug>` the integrator computes) off a freshly-fetched
 * `origin/<base>`. The developer (and rework) steps + the integrator all resolve their cwd to it
 * (see resolveRunCwd), so the user's base checkout is never mutated and concurrent runs on one repo
 * cannot collide. The durable artifact is the pushed branch; the worktree is execution scratch.
 *
 * Replay-safety: `createRunWorktree` is create-IF-ABSENT (a no-op returning the existing path when the
 * worktree is already valid), so a DBOS replay / crash-recovery re-entry never errors and preserves
 * in-flight uncommitted developer work. `releaseRunWorktree` is best-effort and no-ops if absent.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  worktreePathFor,
  worktreeMarkerFor,
  isWorktreeDir,
} from '../control-plane/resolve-cwd.js';
import { resolveExecutable } from '../runners/integrator.js';

/** Synchronous git executor in a given cwd (injectable for tests). */
export type WorktreeExecGit = (args: string[], cwd: string) => string;

const GIT_TIMEOUT_MS = 60_000;

// Resolve `git` to an ABSOLUTE path once (mirrors the integrator's defaultExecGit): execFileSync is
// never handed a bare command name resolved against a mutable PATH at spawn time.
let _gitAbsPath: string | undefined;
function gitAbsPath(): string {
  if (_gitAbsPath === undefined) _gitAbsPath = resolveExecutable('git');
  return _gitAbsPath;
}

/** Default git executor — runs the absolute `git` binary in `cwd`. */
function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync(gitAbsPath(), args, { encoding: 'utf8', cwd, timeout: GIT_TIMEOUT_MS });
}

const INSTALL_TIMEOUT_MS = 300_000;

/** A package-manager install executor in a given cwd (injectable for tests). */
export type WorktreeExecInstall = (args: string[], cwd: string) => void;

/** Default pnpm install executor — runs the absolute `pnpm` binary. Throws if pnpm is unavailable
 *  (the caller treats a throw as "fall back to the node_modules symlink"). */
function defaultExecInstall(args: string[], cwd: string): void {
  execFileSync(resolveExecutable('pnpm'), args, { cwd, timeout: INSTALL_TIMEOUT_MS, stdio: 'ignore' });
}

/**
 * Provision the worktree's dependencies so the developer/tests can build & run.
 *
 * Why pnpm gets a real install (not the symlink): pnpm's `node_modules` is a virtual store of symlinks
 * into `node_modules/.pnpm` wired to the project layout; symlinking the base's `node_modules` into a
 * worktree at a different path shares a MUTABLE tree across runs (one install/postinstall leaks into
 * the base and parallel runs). A `pnpm install --frozen-lockfile` in the worktree is cheap (hard-links
 * from the global content-addressed store, no re-download) and yields a correct, ISOLATED tree from the
 * committed `pnpm-lock.yaml`. Non-pnpm repos keep the best-effort base-`node_modules` symlink.
 */
function provisionDeps(worktreePath: string, baseRepoCwd: string, execInstall: WorktreeExecInstall): void {
  if (existsSync(join(worktreePath, 'pnpm-lock.yaml'))) {
    try {
      execInstall(['install', '--frozen-lockfile'], worktreePath);
      return; // isolated install succeeded — do NOT also symlink
    } catch {
      // pnpm unavailable / install failed — fall through to the symlink fallback below
    }
  }
  try {
    const baseModules = join(baseRepoCwd, 'node_modules');
    const wtModules = join(worktreePath, 'node_modules');
    if (existsSync(baseModules) && !existsSync(wtModules)) {
      symlinkSync(baseModules, wtModules, 'dir');
    }
  } catch {
    // ignore — the developer simply runs without provisioned node_modules
  }
}

export type CreateRunWorktreeOpts = {
  runId: string;
  /** The BASE target-repo checkout (where `git worktree add` runs from). */
  baseRepoCwd: string;
  /** Base branch (e.g. 'master'). */
  base: string;
  /** Feature branch to check out in the worktree — MUST equal the integrator's branch for this run. */
  branch: string;
  dataDir: string;
  execGit?: WorktreeExecGit;
  execInstall?: WorktreeExecInstall;
};

/**
 * Create the run's isolated worktree if absent (idempotent). Returns its path.
 *
 * 1. If a valid worktree already exists at the deterministic path → write the live marker and return
 *    it (replay / recovery: never clobber in-flight developer work).
 * 2. Else: fetch `origin/<base>`, then `git worktree add -B <branch> <path> origin/<base>` (create-or-
 *    reset the feature branch and check it out in the new worktree).
 * 3. Provision deps (provisionDeps): `pnpm install --frozen-lockfile` for a pnpm repo, else a
 *    best-effort base-`node_modules` symlink — so the developer can build/test in the isolated tree.
 * 4. Write the `<runId>.live` marker (fail-loud signal for the resolver).
 */
export function createRunWorktree(opts: CreateRunWorktreeOpts): { worktreePath: string } {
  const { runId, baseRepoCwd, base, branch, dataDir } = opts;
  const execGit = opts.execGit ?? defaultExecGit;
  const execInstall = opts.execInstall ?? defaultExecInstall;
  const worktreePath = worktreePathFor(dataDir, runId);

  if (isWorktreeDir(worktreePath)) {
    writeMarker(dataDir, runId);
    return { worktreePath };
  }

  mkdirSync(dirname(worktreePath), { recursive: true });
  // Fetch the base so the worktree is cut from fresh origin/<base>.
  execGit(['fetch', 'origin', base], baseRepoCwd);
  // -B: create-or-reset <branch> at origin/<base> and check it out in the new linked worktree.
  execGit(['worktree', 'add', '-B', branch, worktreePath, `origin/${base}`], baseRepoCwd);

  // Provision dependencies (pnpm install for a pnpm repo, else node_modules symlink) — best-effort.
  provisionDeps(worktreePath, baseRepoCwd, execInstall);

  writeMarker(dataDir, runId);
  return { worktreePath };
}

export type ReleaseRunWorktreeOpts = {
  runId: string;
  /** The BASE target-repo checkout (where `git worktree remove`/`prune` run from). */
  baseRepoCwd: string;
  dataDir: string;
  execGit?: WorktreeExecGit;
};

/**
 * Release the run's worktree (best-effort, idempotent). Removes the linked worktree + prunes stale
 * administrative entries + drops the live marker. No-ops if the worktree is already gone. Called only
 * at a TERMINAL state — never while parked at a gate (the workflow stays alive across `recv`, so the
 * lifecycle `finally` does not run during a park).
 */
export function releaseRunWorktree(opts: ReleaseRunWorktreeOpts): void {
  const { runId, baseRepoCwd, dataDir } = opts;
  const execGit = opts.execGit ?? defaultExecGit;
  const worktreePath = worktreePathFor(dataDir, runId);

  try {
    if (existsSync(worktreePath)) {
      execGit(['worktree', 'remove', '--force', worktreePath], baseRepoCwd);
    }
  } catch {
    // ignore — fall through to a best-effort dir removal, then prune the admin entry
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  // Prune AFTER any manual removal so the `.git/worktrees/<id>` admin entry is cleaned in both the
  // `git worktree remove` path and the manual-rm fallback path.
  try {
    execGit(['worktree', 'prune'], baseRepoCwd);
  } catch {
    // ignore — prune is housekeeping only
  }
  try {
    rmSync(worktreeMarkerFor(dataDir, runId), { force: true });
  } catch {
    // ignore
  }
}

// The live marker is the signal that makes resolveRunCwd FAIL LOUD on a lost worktree. If it cannot be
// written we must NOT proceed silently (a later lost worktree would then fall back to the shared base
// checkout, masking the isolation failure) — throw so the create step fails and the run surfaces it.
function writeMarker(dataDir: string, runId: string): void {
  writeFileSync(worktreeMarkerFor(dataDir, runId), `${runId}\n`, 'utf8');
}
