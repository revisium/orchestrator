/**
 * resolve-cwd.ts — shared B1 contract for resolving the working directory from a repo_ref.
 *
 * B1 CONTRACT — the resolved working directory MUST be an existing directory. We accept:
 *   • '' or '.'                  → base (the workspace cwd)
 *   • an ABSOLUTE existing dir   → that dir (the external target repo — the MVP case)
 *   • a relative path under base → resolve(base, ref), if it stays under base AND exists
 * We REJECT (throw a lesson-bearing error):
 *   • a non-existent path        → never launch claude in a directory that isn't there
 *   • a path that is not a dir   → never launch claude against a file
 *   • a relative '../…' escape   → traversal guard (only relative refs are guarded; an ABSOLUTE
 *                                   ref is taken as the literal target repo, existence-checked).
 */
import { resolve, isAbsolute, relative, sep, join } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { ControlPlaneDataAccess } from './data-access.js';
import { toStr, type Step } from './steps.js';

/** Resolve a repo_ref string to an absolute, existing directory path. */
export async function resolveRepoCwdFromRef(repoRef: string, base: string): Promise<string> {
  if (repoRef === '' || repoRef === '.') return base;
  const resolved = isAbsolute(repoRef) ? resolve(repoRef) : resolve(base, repoRef);
  if (!isAbsolute(repoRef) && resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(
      `resolveCwd: relative repo_ref ${JSON.stringify(repoRef)} escapes the workspace base ` +
        `${JSON.stringify(base)} — refusing to launch`,
    );
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(
      `resolveCwd: repo path ${JSON.stringify(resolved)} does not exist or is not a directory ` +
        `— refusing to launch claude`,
    );
  }
  // Symlink escape guard: canonicalize via realpathSync and re-check containment.
  // This prevents a symlink inside the allowed base from pointing outside it.
  // Only applied when the ref is relative (absolute refs designate an external target repo
  // and are accepted as-is — their real path IS the intended target).
  if (!isAbsolute(repoRef)) {
    let realTarget: string;
    let realBase: string;
    try {
      realTarget = realpathSync(resolved);
      realBase = realpathSync(base);
    } catch {
      // realpathSync throws on non-existent paths — treat as non-existent (same as above check).
      throw new Error(
        `resolveCwd: repo path ${JSON.stringify(resolved)} does not exist or is not a directory ` +
          `— refusing to launch claude`,
      );
    }
    const rel = relative(realBase, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `resolveCwd: relative repo_ref ${JSON.stringify(repoRef)} escapes the workspace base ` +
          `${JSON.stringify(base)} via symlink — refusing to launch`,
      );
    }
  }
  return resolved;
}

async function readRepoRef(da: ControlPlaneDataAccess, taskId: string): Promise<string> {
  const task = await da.getRow('tasks', taskId);
  if (task === null) {
    throw new Error(
      `resolveCwd: task ${taskId} not found — cannot resolve a working directory`,
    );
  }
  return toStr(task.data.repo_ref);
}

// ─── Per-run worktree isolation (plan 0017) ────────────────────────────────────

/**
 * Deterministic per-run worktree path: `<dataDir>/worktrees/<runId>`. COMPUTED, never stored —
 * preserving invariant #1 (no durable state in local files; the durable artifact is the pushed
 * branch + DBOS progress, the worktree is execution scratch). Sited under the data dir, NOT inside
 * the target repo, so a live worktree never pollutes the target's own `git status`.
 */
/** Guard a value used as a single filesystem path segment — refuse separators / traversal so a
 *  malformed runId can never make a worktree path escape `<dataDir>/worktrees/` (release rm's it). */
function assertPathSegment(value: string, label: string): void {
  if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0')) {
    throw new Error(`${label} ${JSON.stringify(value)} must be a single safe path segment`);
  }
}

export function worktreePathFor(dataDir: string, runId: string): string {
  assertPathSegment(runId, 'runId');
  return join(dataDir, 'worktrees', runId);
}

/**
 * Live-run worktree marker: `<dataDir>/worktrees/<runId>.live`. Its presence means "this run is live
 * and MUST resolve to its worktree". It lets the run resolver FAIL LOUD when a live run's worktree is
 * missing/lost instead of silently falling back to the shared base checkout (which would re-introduce
 * the exact cross-run corruption worktree isolation exists to prevent). Written at create, removed at
 * release.
 */
export function worktreeMarkerFor(dataDir: string, runId: string): string {
  assertPathSegment(runId, 'runId');
  return join(dataDir, 'worktrees', `${runId}.live`);
}

/**
 * A path is a usable LINKED git worktree iff it is a directory carrying a `.git` POINTER FILE (a linked
 * worktree's `.git` is a file `gitdir: …`, never a directory). Requiring a file rejects a normal clone's
 * `.git` directory and stale/corrupt paths, so a live run never silently runs effects in an invalid tree.
 */
export function isWorktreeDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && lstatSync(join(path, '.git')).isFile();
  } catch {
    return false;
  }
}

/**
 * RUN-level resolver (plan 0017) — the cwd for every repo-touching LIVE effect (developer/rework steps
 * + the integrator). Prefers the run's isolated worktree; FAILS LOUD for a live run whose worktree is
 * missing (marker present, worktree gone); falls back to the shared base checkout ONLY for non-live
 * runs (script/stub do no real git, so no worktree/marker is ever created for them).
 */
export async function resolveRunCwd(
  da: ControlPlaneDataAccess,
  dataDir: string,
  runId: string,
  taskId: string,
  base = process.cwd(),
): Promise<string> {
  const wt = worktreePathFor(dataDir, runId);
  if (isWorktreeDir(wt)) return wt;
  if (existsSync(worktreeMarkerFor(dataDir, runId))) {
    throw new Error(
      `resolveRunCwd: live run ${runId} expects an isolated worktree at ${JSON.stringify(wt)} ` +
        `but it is missing or invalid — refusing to fall back to the shared base checkout`,
    );
  }
  return resolveRepoCwdFromRef(await readRepoRef(da, taskId), base);
}

/**
 * STEP-level resolver (M3, plan 0017) — shape expected by the claude runner: (step) => Promise<string>.
 * Now WORKTREE-AWARE: resolves to the run's isolated worktree (keyed by step.runId) for live runs,
 * else the shared base checkout. Reads tasks.repo_ref via the data-access layer for the fallback.
 */
export function makeResolveCwd(
  da: ControlPlaneDataAccess,
  dataDir: string,
  base = process.cwd(),
): (step: Step) => Promise<string> {
  return (step) => resolveRunCwd(da, dataDir, step.runId, step.taskId, base);
}

/**
 * RUN-level resolver shape for the integrator: (runId, taskId) => Promise<string>. Same contract as
 * the step resolver but keyed explicitly by runId (concurrent runs share a taskId, so the integrator
 * MUST resolve by runId or two runs collide on one tree).
 */
export function makeResolveRunCwd(
  da: ControlPlaneDataAccess,
  dataDir: string,
  base = process.cwd(),
): (runId: string, taskId: string) => Promise<string> {
  return (runId, taskId) => resolveRunCwd(da, dataDir, runId, taskId, base);
}

/**
 * TASK-level resolver (M3) — the BASE checkout, keyed by taskId: (taskId: string) => Promise<string>.
 * Used by the LIVE PREFLIGHT, which must run against the user's base checkout BEFORE the worktree is
 * created (its fetch + clean/freshness checks protect the base repo). NOT worktree-aware by design.
 */
export function makeResolveTaskCwd(
  da: ControlPlaneDataAccess,
  base = process.cwd(),
): (taskId: string) => Promise<string> {
  return async (taskId) => resolveRepoCwdFromRef(await readRepoRef(da, taskId), base);
}
