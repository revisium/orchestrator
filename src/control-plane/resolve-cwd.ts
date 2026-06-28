










import { resolve, isAbsolute, relative, sep, join } from 'node:path';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import type { ControlPlaneDataAccess } from './data-access.js';
import { toStr, type Step } from './steps.js';


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
  if (!isAbsolute(repoRef)) {
    let realTarget: string;
    let realBase: string;
    try {
      realTarget = realpathSync(resolved);
      realBase = realpathSync(base);
    } catch {
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






function assertPathSegment(value: string, label: string): void {
  if (value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('..') || value.includes('\0')) {
    throw new Error(`${label} ${JSON.stringify(value)} must be a single safe path segment`);
  }
}

export function worktreePathFor(dataDir: string, runId: string): string {
  assertPathSegment(runId, 'runId');
  return join(dataDir, 'worktrees', runId);
}






export function worktreeMarkerFor(dataDir: string, runId: string): string {
  assertPathSegment(runId, 'runId');
  return join(dataDir, 'worktrees', `${runId}.live`);
}




export function isWorktreeDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && lstatSync(join(path, '.git')).isFile();
  } catch {
    return false;
  }
}





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




export function makeResolveCwd(
  da: ControlPlaneDataAccess,
  dataDir: string,
  base = process.cwd(),
): (step: Step) => Promise<string> {
  return (step) => resolveRunCwd(da, dataDir, step.runId, step.taskId, base);
}




export function makeResolveRunCwd(
  da: ControlPlaneDataAccess,
  dataDir: string,
  base = process.cwd(),
): (runId: string, taskId: string) => Promise<string> {
  return (runId, taskId) => resolveRunCwd(da, dataDir, runId, taskId, base);
}




export function makeResolveTaskCwd(
  da: ControlPlaneDataAccess,
  base = process.cwd(),
): (taskId: string) => Promise<string> {
  return async (taskId) => resolveRepoCwdFromRef(await readRepoRef(da, taskId), base);
}
