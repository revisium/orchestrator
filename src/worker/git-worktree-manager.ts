/**
 * git-worktree-manager.ts — per-RUN git worktree lifecycle (plan 0017).
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

/** Synchronous git executor in a given cwd (injectable for tests). */
export type WorktreeExecGit = (args: string[], cwd: string) => string;

const GIT_TIMEOUT_MS = 60_000;

/** Default git executor — bare `git` resolved via PATH by execFileSync. */
function defaultExecGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { encoding: 'utf8', cwd, timeout: GIT_TIMEOUT_MS });
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
};

/**
 * Create the run's isolated worktree if absent (idempotent). Returns its path.
 *
 * 1. If a valid worktree already exists at the deterministic path → write the live marker and return
 *    it (replay / recovery: never clobber in-flight developer work).
 * 2. Else: fetch `origin/<base>`, then `git worktree add -B <branch> <path> origin/<base>` (create-or-
 *    reset the feature branch and check it out in the new worktree).
 * 3. Best-effort symlink the base repo's `node_modules` into the worktree (so the developer can run
 *    tests/tsc) — skipped gracefully when the base has none / is not a Node repo.
 * 4. Write the `<runId>.live` marker (fail-loud signal for the resolver).
 */
export function createRunWorktree(opts: CreateRunWorktreeOpts): { worktreePath: string } {
  const { runId, baseRepoCwd, base, branch, dataDir } = opts;
  const execGit = opts.execGit ?? defaultExecGit;
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

  // Best-effort node_modules symlink (graceful for non-Node / depless targets).
  try {
    const baseModules = join(baseRepoCwd, 'node_modules');
    const wtModules = join(worktreePath, 'node_modules');
    if (existsSync(baseModules) && !existsSync(wtModules)) {
      symlinkSync(baseModules, wtModules, 'dir');
    }
  } catch {
    // ignore — the developer simply runs without a symlinked node_modules
  }

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
    // ignore — fall through to prune + best-effort dir removal
  }
  try {
    execGit(['worktree', 'prune'], baseRepoCwd);
  } catch {
    // ignore — prune is housekeeping only
  }
  try {
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  try {
    rmSync(worktreeMarkerFor(dataDir, runId), { force: true });
  } catch {
    // ignore
  }
}

function writeMarker(dataDir: string, runId: string): void {
  try {
    writeFileSync(worktreeMarkerFor(dataDir, runId), `${runId}\n`, 'utf8');
  } catch {
    // ignore — the marker is a fail-loud hint; absence only weakens the loud-fail, not correctness
  }
}
