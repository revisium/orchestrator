/**
 * integrator-git — git-binary resolution + the pure git primitives the integrator needs
 * (branch existence, ahead-count). Lifted from integrator.ts. `resolveExecutable` is also imported by
 * the worktree manager, so integrator.ts re-exports it to keep that import path stable.
 */
import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import type { ExecFn } from './integrator-types.js';

/**
 * Resolve a bare executable name to its first absolute path on PATH.
 * Uses only node:fs + node:path — no child_process, no spawning.
 *
 * @param name  - bare executable name, e.g. "git"
 * @param pathEnv - override for PATH (defaults to process.env.PATH); injectable for tests
 * @returns absolute path to the executable
 * @throws Error if not found on PATH
 */
export function resolveExecutable(name: string, pathEnv = process.env['PATH'] ?? ''): string {
  if (!pathEnv) {
    throw new Error(`cannot resolve executable "${name}" on PATH: PATH is empty or unset`);
  }

  const dirs = pathEnv.split(delimiter);

  // On win32 also check common executable extensions; on posix the plain name suffices.
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
        // dir may be unreadable — skip silently
      }
    }
  }

  throw new Error(`cannot resolve executable "${name}" on PATH`);
}

// Lazily resolved once per process — avoids resolving on module load (safe for tests).
let _gitAbsPath: string | undefined;
export function gitAbsPath(): string {
  if (_gitAbsPath === undefined) {
    _gitAbsPath = resolveExecutable('git');
  }
  return _gitAbsPath;
}

/** Branch existence check — returns true if the branch exists locally. */
export function branchExists(execGit: ExecFn, cwd: string, branch: string): boolean {
  try {
    execGit(['rev-parse', '--verify', branch], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count commits on branch ahead of origin/<base>.
 * Returns 0 only for expected "no upstream / unknown revision / ambiguous argument" errors
 * (these mean the branch is not ahead). Rethrows other errors so DBOS can retry transient failures.
 */
export function countAhead(execGit: ExecFn, cwd: string, branch: string, base: string): number {
  try {
    const raw = execGit(['rev-list', '--count', `origin/${base}..${branch}`], cwd).trim();
    return Number.parseInt(raw, 10) || 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected: branch or upstream not yet known to git (not a transient failure).
    if (
      msg.includes('unknown revision') ||
      msg.includes('ambiguous argument') ||
      msg.includes('no upstream') ||
      msg.includes('does not have any commits yet')
    ) {
      return 0;
    }
    // Transient failure (network, lock, etc.) — rethrow so DBOS retries.
    throw err;
  }
}
