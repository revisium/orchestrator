/**
 * Rogue-reaper (slice 140 Phase 2, pure core). `revo doctor --fix` / `revo stop --all` actively EVICT
 * a legacy/duplicate daemon that polls the `dev-tasks` queue but the advisory lock can't coordinate and
 * the port-based stop can't see (it's an outbound poller with no inbound listener). Two mechanisms:
 *
 *   1. Connection eviction — `pg_terminate_backend` the rogue's DBOS connection (the immediate stop),
 *      looped to defeat the census→kill TOCTOU (a rogue can dequeue a fresh row in that window).
 *   2. Process reap — SIGTERM→SIGKILL the rogue PROCESS (the durable stop; its pool would otherwise
 *      reconnect). This is what the manual `pkill -f "revo mcp"` did, made safe + permanent.
 *
 * This module holds the PURE, unit-tested decisions; the pg/ps/kill IO lives in lifecycle.ts.
 */
import { isPidWithin } from './process-tree.js';

export type RevoProcKind = 'daemon' | 'mcp';

/**
 * Classify a process command line as a revo daemon / mcp-bridge, or null if unrelated.
 *
 * Keys on (revo entry token) + (subcommand token). The npm-GLOBAL install runs as
 * `node …/bin/revo __daemon` — argv[1] is the bin SYMLINK (`bin/revo`, no `.js`); the package's own
 * `bin/revo.js` does `import '../dist/cli/index.js'` (no re-exec); dev runs as
 * `node --import tsx …/src/cli/index.ts __daemon`; a compiled run as `…/dist/cli/index.js`. Matching
 * only `dist/cli/index.js` (or only `bin/revo.js`) MISSES the real installed daemon and the reap
 * no-ops against the very process it must kill. The subcommand must be a whole word so an unrelated
 * command merely containing "mcp" (e.g. `node /opt/mcp-server.js`) is not matched.
 */
export function classifyRevoProcess(command: string): RevoProcKind | null {
  const hasEntry =
    /\/bin\/revo(?:\.js)?(?:\s|$)/.test(command) || /\/cli\/index\.(?:ts|js)(?:\s|$)/.test(command);
  if (!hasEntry) return null;
  if (/(?:^|\s)__daemon(?:\s|$)/.test(command)) return 'daemon';
  if (/(?:^|\s)mcp(?:\s|$)/.test(command)) return 'mcp';
  return null;
}

export type RevoProc = { pid: number; command: string; startTime: string | null; kind: RevoProcKind };

/**
 * The reap targets: revo daemon/mcp processes NOT within any PROTECTED tree (every profile's tracked
 * daemon pid-tree). A process inside a tracked tree is the live stack — never reaped. `getParent` is
 * injected so the ancestry walk is unit-testable without real processes.
 */
export function selectReapTargets(
  procs: ReadonlyArray<RevoProc>,
  protectedPids: ReadonlySet<number>,
  getParent: (pid: number) => number | null,
): RevoProc[] {
  return procs.filter((proc) => !isPidWithin(proc.pid, protectedPids, getParent));
}

export type EvictionOutcome = { converged: boolean; rounds: number; terminated: number };

/**
 * Connection-eviction TOCTOU loop. `census()` returns the current rogue backend pids (it THROWS if the
 * roster can't be read — privilege/DB error — which must propagate as "not converged", never as empty);
 * `terminate(pid)` kills one backend. Re-census after each round because a rogue can transition a fresh
 * ENQUEUED row to its own PENDING between the census and the kill. Bounded by `maxRounds`.
 */
export async function evictByTermination(
  census: () => Promise<number[]>,
  terminate: (pid: number) => Promise<void>,
  maxRounds = 5,
): Promise<EvictionOutcome> {
  let terminated = 0;
  for (let round = 1; round <= maxRounds; round += 1) {
    const rogues = await census();
    if (rogues.length === 0) return { converged: true, rounds: round, terminated };
    for (const pid of rogues) {
      await terminate(pid);
      terminated += 1;
    }
  }
  const remaining = await census();
  return { converged: remaining.length === 0, rounds: maxRounds, terminated };
}
