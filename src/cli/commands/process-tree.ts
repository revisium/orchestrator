/**
 * Process-tree ancestry — used by `revo doctor` to decide whether a port's listener belongs to the
 * tracked stack. A profile's standalone tier is NOT a single pid: the tracked launcher forks a worker
 * that binds the HTTP port and spawns embedded Postgres, so the actual port owners are *descendants*
 * of the tracked pid. Exact-pid equality therefore mis-flags the legitimate stack as a rogue daemon;
 * ancestry-walking is the correct test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Resolve ps to a FIXED absolute path — never via $PATH (S4036: a writable PATH entry could shadow
// the binary). null if ps is unavailable, in which case ancestry checks degrade to "not within".
const PS_PATH = ['/bin/ps', '/usr/bin/ps'].find((p) => existsSync(p)) ?? null;

/** Parent pid of `pid` via ps, or null (no such process / ps unavailable). Best-effort. */
export function parentPid(pid: number): number | null {
  if (PS_PATH === null) return null;
  try {
    const out = execFileSync(PS_PATH, ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const ppid = Number(out);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null; // process gone / ps error
  }
}

/**
 * True if `pid` is one of `ancestors`, or descends from one — walking the parent chain via `getParent`.
 * `getParent` is injectable so the traversal is unit-testable without real processes; production passes
 * `parentPid`. Bounded by `maxHops` (and stops at init, pid ≤ 1) so a missing/cyclic chain can't loop.
 */
export function isPidWithin(
  pid: number,
  ancestors: ReadonlySet<number>,
  getParent: (p: number) => number | null = parentPid,
  maxHops = 32,
): boolean {
  let current: number | null = pid;
  for (let hops = 0; current !== null && hops <= maxHops; hops += 1) {
    if (ancestors.has(current)) return true;
    if (current <= 1) return false; // reached init (or invalid) — not within the tracked tree
    current = getParent(current);
  }
  return false; // exhausted hops / chain broke before reaching an ancestor
}
