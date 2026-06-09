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
import { resolve, isAbsolute, relative, sep } from 'node:path';
import { existsSync, realpathSync, statSync } from 'node:fs';
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

/**
 * STEP-level resolver (M3) — shape expected by claude runner: (step: Step) => Promise<string>.
 * Reads tasks.repo_ref for the step's taskId via the data-access layer.
 */
export function makeResolveCwd(
  da: ControlPlaneDataAccess,
  base = process.cwd(),
): (step: Step) => Promise<string> {
  return async (step) => resolveRepoCwdFromRef(await readRepoRef(da, step.taskId), base);
}

/**
 * TASK-level resolver (M3) — shape expected by the integrator + live preflight: (taskId: string) => Promise<string>.
 * Uses the same core as makeResolveCwd over one shared readRepoRef.
 */
export function makeResolveTaskCwd(
  da: ControlPlaneDataAccess,
  base = process.cwd(),
): (taskId: string) => Promise<string> {
  return async (taskId) => resolveRepoCwdFromRef(await readRepoRef(da, taskId), base);
}
