


import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import type { ExecFn } from './integrator-types.js';








export function resolveExecutable(name: string, pathEnv = process.env['PATH'] ?? ''): string {
  if (!pathEnv) {
    throw new Error(`cannot resolve executable "${name}" on PATH: PATH is empty or unset`);
  }

  const dirs = pathEnv.split(delimiter);

  const candidates =
    process.platform === 'win32'
      ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`]
      : [name];

  for (const dir of dirs) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      try {
        if (existsSync(full) && statSync(full).isFile()) {
          return full;
        }
      } catch {
      }
    }
  }

  throw new Error(`cannot resolve executable "${name}" on PATH`);
}

let _gitAbsPath: string | undefined;
export function gitAbsPath(): string {
  if (_gitAbsPath === undefined) {
    _gitAbsPath = resolveExecutable('git');
  }
  return _gitAbsPath;
}


export function branchExists(execGit: ExecFn, cwd: string, branch: string): boolean {
  try {
    execGit(['rev-parse', '--verify', branch], cwd);
    return true;
  } catch {
    return false;
  }
}




export function countAhead(execGit: ExecFn, cwd: string, branch: string, base: string): number {
  try {
    const raw = execGit(['rev-list', '--count', `origin/${base}..${branch}`], cwd).trim();
    return Number.parseInt(raw, 10) || 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes('unknown revision') ||
      msg.includes('ambiguous argument') ||
      msg.includes('no upstream') ||
      msg.includes('does not have any commits yet')
    ) {
      return 0;
    }
    throw err;
  }
}
