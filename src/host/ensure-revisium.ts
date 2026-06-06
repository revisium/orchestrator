/**
 * ensureRevisium() — shared auto-start helper (Round 3).
 *
 * Models three distinct states (F7):
 *   1. HEALTHY     → no-op, return proven runtime.
 *   2. NO LIVE DAEMON (null runtime or dead pid) → fresh detached spawn + wait.
 *   3. ALIVE BUT UNHEALTHY → bounded re-poll, then throw (never orphan a live process).
 *
 * Called by BOTH `revisium start` command and host bootstrap (DRY extraction, F9).
 *
 * TOCTOU / compare-and-delete (F16, F19, F21):
 *   In state 2 we re-classify IMMEDIATELY before any removal. decideRuntimeAction()
 *   returns a RuntimeDecision that encodes BOTH the action AND shouldRemove — so the
 *   identity rule (only remove when the recheck still matches the stale snapshot by pid
 *   AND startedAt) lives in one tested place and the caller cannot drift from it (F21).
 *
 *   The same removeRuntimeIfMatches() helper is shared by the state-2 pre-spawn cleanup
 *   AND the spawn-timeout cleanup (F19), so neither path can accidentally delete a runtime
 *   that belongs to a concurrently-started daemon.
 *
 * Known limitation — concurrent cold-start (deferred per ТЗ §3.3.5, slice 0001):
 *   Two host processes starting with no live daemon in the same narrow window can still
 *   race to spawn — the compare-and-delete re-check narrows the orphan window but does
 *   NOT serialize spawns. Full cross-process file-locking is intentionally deferred to a
 *   future slice. The practical guard is the re-check plus the fact that the host path
 *   only runs for explicit dev:* invocations.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  baseUrl,
  findFreePort,
  getConfig,
  healthUrl,
  isAlive,
  isHealthy,
  readRuntime,
  removeRuntime,
  type RuntimeState,
} from '../cli/config.js';
import {
  killTree,
  parsePort,
  tailLines,
  waitForExit,
  waitHealthy,
} from '../cli/commands/revisium-helpers.js';

const require = createRequire(import.meta.url);

/** Default cold-start timeout in ms (120 s — matches the existing waitHealthy default). */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Default re-poll budget for the alive-but-unhealthy case (consensus MINOR, round 4). */
const DEFAULT_RECHECK_MS = 20_000;

/**
 * Minimal identity snapshot used for compare-and-delete (F19, F21).
 * Carries only the fields needed to confirm a runtime.json belongs to a specific process.
 */
type RuntimeSnapshot = Pick<RuntimeState, 'pid' | 'startedAt'>;

/**
 * Remove runtime.json ONLY if the current file on disk still matches the given snapshot
 * (same pid AND startedAt). Shared by the state-2 pre-spawn path and the spawn-timeout
 * cleanup path (F19 / F21 DRY) so neither can accidentally delete a runtime that belongs
 * to a concurrently-started daemon.
 *
 * If the file has been replaced (different identity) or already removed (null), this is a
 * safe no-op — the file either belongs to another process or was already cleaned up.
 *
 * Exported (@internal) for unit testing; production callers should use only the internal
 * call sites (state-2 pre-spawn cleanup and spawn-timeout cleanup).
 */
export function removeRuntimeIfMatches(snapshot: RuntimeSnapshot): void {
  const current = readRuntime();
  if (current && current.pid === snapshot.pid && current.startedAt === snapshot.startedAt) {
    removeRuntime();
  }
}

export type EnsureResult = {
  runtime: RuntimeState;
  alreadyRunning: boolean;
};

export type EnsureRevisiumOptions = {
  port?: string;
  pgPort?: string;
  data?: string;
  /** Cold-start spawn budget in ms. Default 120 000. */
  timeoutMs?: number;
  /** Alive-but-unhealthy re-poll budget in ms. Default 20 000. */
  recheckMs?: number;
};

/** Decision values for the three-state classifier (F15). */
export type RuntimeStateClass = 'healthy' | 'no-live-daemon' | 'alive-unhealthy';

/**
 * Action values returned inside RuntimeDecision.
 *
 *  'return-running'   → re-check showed a live+healthy daemon; return alreadyRunning=true.
 *  'repoll'           → re-check showed a live-but-unhealthy daemon; do bounded re-poll.
 *  'throw-unhealthy'  → re-poll budget expired and pid is still alive; throw error.
 *  'remove-and-spawn' → stale file still matches snapshot (compare-and-delete OK to remove).
 *  'spawn'            → no stale file existed; safe to spawn directly.
 */
export type RuntimeAction =
  | 'return-running'
  | 'repoll'
  | 'throw-unhealthy'
  | 'remove-and-spawn'
  | 'spawn';

/**
 * Structured decision returned by decideRuntimeAction() (F21).
 *
 * Encodes BOTH the action AND whether `removeRuntime()` should be called,
 * so the snapshot-identity rule lives in one tested place and the caller
 * cannot drift from it.
 *
 * `shouldRemove` is true ONLY when:
 *   - action === 'remove-and-spawn', AND
 *   - the recheck runtime still matches the stale snapshot by pid AND startedAt
 *     (compare-and-delete identity check).
 *
 * When `shouldRemove` is false the caller must NOT call removeRuntime() — the
 * runtime file either belongs to a concurrent live daemon or was already cleaned up.
 */
export type RuntimeDecision = {
  action: RuntimeAction;
  /** True only when removeRuntime() may safely be called (identity-confirmed stale file). */
  shouldRemove: boolean;
};

/**
 * Decide what action to take in state 2 ("no live daemon" from initial classification)
 * given the stale snapshot and an immediate re-read immediately before any removal.
 *
 * Pure function (no side effects, no I/O) — unit-testable in isolation (F18 / F16 / F21).
 *
 * Compare-and-delete contract (F16, F21):
 *   - shouldRemove is true ONLY when the re-read runtime STILL matches the stale snapshot
 *     (same pid AND startedAt). This prevents deleting a live runtime written concurrently
 *     BETWEEN our initial dead-pid read and this re-check.
 *   - If the re-check shows a DIFFERENT (or new) live pid, the action routes into alive
 *     paths ('return-running' or 'repoll') and shouldRemove is always false.
 *
 * @param stalePidSnapshot - The RuntimeState we observed initially (dead pid), or null.
 * @param recheck          - The result of readRuntime() immediately before removal.
 * @param recheckAlive     - Whether recheck.pid is alive (ignored when recheck is null).
 * @param recheckHealthy   - Whether recheck daemon is healthy (ignored when recheck is null).
 */
export function decideRuntimeAction(
  stalePidSnapshot: RuntimeState | null,
  recheck: RuntimeState | null,
  recheckAlive: boolean,
  recheckHealthy: boolean,
): RuntimeDecision {
  if (recheck && recheckAlive) {
    // A concurrent process wrote a live runtime — do NOT delete or spawn over it.
    if (recheckHealthy) return { action: 'return-running', shouldRemove: false };
    return { action: 'repoll', shouldRemove: false };
  }

  // No live runtime after re-read. Determine whether we may remove the stale file.
  if (stalePidSnapshot !== null) {
    // Compare-and-delete identity check (F21): only set shouldRemove=true when the
    // recheck runtime STILL matches the stale snapshot (same pid AND startedAt).
    // - recheck null → file already cleaned up by another process; skip remove but proceed.
    // - recheck present but different identity → new stale entry from a different past run;
    //   our snapshot doesn't own it — leave it for its owner.
    const matchesSnapshot =
      recheck !== null &&
      recheck.pid === stalePidSnapshot.pid &&
      recheck.startedAt === stalePidSnapshot.startedAt;
    return { action: 'remove-and-spawn', shouldRemove: matchesSnapshot };
  }
  return { action: 'spawn', shouldRemove: false };
}

/**
 * Classify the daemon state given a snapshot of: the runtime file, whether the
 * recorded pid is alive, and whether the daemon responds to health checks.
 *
 * Pure function (no side effects, no I/O) — unit-testable in isolation (F15).
 *
 * - 'healthy'       → pid alive AND health check passed.
 * - 'alive-unhealthy' → pid alive BUT health check failed (never spawn a second daemon).
 * - 'no-live-daemon'  → no runtime.json OR recorded pid is dead (safe to spawn fresh).
 *
 * Note: the alive-unhealthy case intentionally includes a concurrent-start scenario
 * where the runtime was written but the daemon is mid-startup (F11): returning
 * 'alive-unhealthy' rather than 'no-live-daemon' routes callers into the bounded
 * re-poll path instead of unconditionally spawning a second daemon.
 */
export function classifyRuntimeState(
  rt: RuntimeState | null,
  alive: boolean,
  healthy: boolean,
): RuntimeStateClass {
  if (!rt || !alive) return 'no-live-daemon';
  if (healthy) return 'healthy';
  return 'alive-unhealthy';
}

/**
 * Ensure the Revisium standalone daemon is running and healthy.
 *
 * Three-state logic (F7):
 *   - State 1: recorded pid alive + healthy → return immediately (alreadyRunning = true).
 *   - State 2: no runtime.json OR recorded pid is dead → removeRuntime if stale, spawn fresh.
 *   - State 3: recorded pid alive but unhealthy → bounded re-poll (recheckMs), then THROW
 *     (never removeRuntime, never spawn — leaves the live process for `revo revisium stop`).
 *
 * @returns EnsureResult with the pid-proven runtime (fresh or existing).
 * @throws if the daemon is alive-but-unhealthy after re-poll, or if spawn times out.
 */
export async function ensureRevisium(
  options: EnsureRevisiumOptions = {},
): Promise<EnsureResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, recheckMs = DEFAULT_RECHECK_MS } = options;
  const config = getConfig();
  const rt = readRuntime();
  const alive = rt ? isAlive(rt.pid) : false;
  const healthy = rt && alive ? await isHealthy(rt.httpPort) : false;
  const stateClass = classifyRuntimeState(rt, alive, healthy);

  // ── State 1: healthy ──────────────────────────────────────────────────────
  if (stateClass === 'healthy') {
    return { runtime: rt!, alreadyRunning: true };
  }

  // ── State 3: alive but unhealthy ─────────────────────────────────────────
  if (stateClass === 'alive-unhealthy') {
    // Do NOT remove runtime or spawn. Bounded re-poll first.
    const becameHealthy = await waitHealthy(healthUrl(rt!.httpPort), recheckMs);
    if (becameHealthy) {
      // Late-up daemon; proceed with the existing runtime.
      const freshRt = readRuntime();
      if (!freshRt) throw new Error('runtime.json disappeared during re-poll');
      return { runtime: freshRt, alreadyRunning: true };
    }
    // Still unhealthy with a live pid — THROW, do not orphan.
    throw new Error(
      `Revisium (pid ${rt!.pid}) is running but unhealthy — run \`revo revisium stop\` and retry`,
    );
  }

  // ── State 2: no live daemon ───────────────────────────────────────────────
  //
  // F16 / F21 compare-and-delete: re-classify IMMEDIATELY before any removal.
  // A concurrent process may have written a NEW live runtime.json between our
  // initial dead-pid snapshot and this point. We must NOT blindly removeRuntime()
  // and spawn — that would delete the concurrent process's live runtime and
  // create an orphan daemon.
  //
  // Algorithm:
  //   1. Re-read runtime now (before touching anything).
  //   2. decideRuntimeAction() returns a RuntimeDecision with both the action AND
  //      shouldRemove — the identity check lives inside that pure function (F21).
  //   3. Only call removeRuntimeIfMatches() when decision.shouldRemove is true —
  //      it is a second guard that confirms the file on disk still matches our
  //      snapshot (same pid AND startedAt) before deleting.
  const rtRecheck = readRuntime();
  const recheckAlive = rtRecheck ? isAlive(rtRecheck.pid) : false;
  const recheckHealthy = rtRecheck && recheckAlive ? await isHealthy(rtRecheck.httpPort) : false;
  const decision = decideRuntimeAction(rt, rtRecheck, recheckAlive, recheckHealthy);

  if (decision.action === 'return-running') {
    return { runtime: rtRecheck!, alreadyRunning: true };
  }

  if (decision.action === 'repoll') {
    // Concurrent start wrote a live-but-unhealthy runtime — bounded re-poll (may be mid-startup).
    const becameHealthy = await waitHealthy(healthUrl(rtRecheck!.httpPort), recheckMs);
    if (becameHealthy) {
      const freshRt = readRuntime();
      if (!freshRt) throw new Error('runtime.json disappeared during recheck re-poll');
      return { runtime: freshRt, alreadyRunning: true };
    }
    // Still unhealthy with a live pid after re-poll — throw rather than orphan.
    throw new Error(
      `Revisium (pid ${rtRecheck!.pid}) is running but unhealthy — run \`revo revisium stop\` and retry`,
    );
  }

  // action === 'remove-and-spawn' or 'spawn'
  // decision.shouldRemove is true only when the recheck runtime still matches the
  // stale snapshot (identity confirmed by decideRuntimeAction — F21).
  // F22: use removeRuntimeIfMatches(rtRecheck) — NOT bare removeRuntime() — so we
  // re-read and compare pid+startedAt AT DELETE TIME, identical to the timeout path.
  // This prevents a concurrent replacement between decideRuntimeAction() and the
  // actual delete from wiping a live runtime written by another process.
  if (decision.shouldRemove) removeRuntimeIfMatches(rtRecheck!);

  // Start + Wait
  const httpPort = await findFreePort(parsePort(options.port, config.preferredPort));
  const pgPort = await findFreePort(parsePort(options.pgPort, config.preferredPgPort));
  const dataDir = options.data ?? config.dataDir;

  const entry = require.resolve('@revisium/standalone/bin/revisium-standalone.js') as string;
  const out = openSync(config.logFile, 'a');
  const child = spawn(
    process.execPath,
    [entry, '--port', String(httpPort), '--pg-port', String(pgPort), '--data', dataDir],
    { detached: true, stdio: ['ignore', out, out] },
  );
  closeSync(out);

  if (!child.pid) {
    throw new Error('Failed to start standalone Revisium: spawn returned no pid');
  }

  child.unref(); // detached — daemon outlives this process

  // Capture the exact identity of the runtime WE just wrote (F19).
  // The timeout cleanup path uses removeRuntimeIfMatches(spawnSnapshot) so it only
  // deletes THIS process's runtime.json and never a concurrently-started daemon's file.
  const spawnStartedAt = new Date().toISOString();

  // Write extended runtime.json (F8: includes dataDir for postmaster.pid cross-check).
  writeFileSync(
    config.runtimeFile,
    JSON.stringify(
      { httpPort, pgPort, pid: child.pid, startedAt: spawnStartedAt, dataDir },
      null,
      2,
    ),
  );

  /** Identity snapshot of the runtime WE wrote — used for compare-and-delete on timeout. */
  const spawnSnapshot = { pid: child.pid, startedAt: spawnStartedAt };

  const spawnHealthy = await waitHealthy(healthUrl(httpPort), timeoutMs);
  if (!spawnHealthy) {
    // Cleanup the child WE spawned (not a live-owned daemon).
    // F19: Only removeRuntime() when the file still identifies OUR child (compare-and-delete).
    // A concurrent process may have already replaced runtime.json with its own entry.
    const logTail = tailLines(config.logFile, 20);
    killTree(child.pid, 'SIGTERM');
    await waitForExit(child.pid, 20_000);
    if (isAlive(child.pid)) killTree(child.pid, 'SIGKILL');
    removeRuntimeIfMatches(spawnSnapshot);
    throw new Error(
      `Revisium did not become healthy on ${baseUrl(httpPort)} within ${timeoutMs / 1000}s` +
        ` — see \`revo revisium logs\`\n${logTail}`,
    );
  }

  // Re-read the freshly-written runtime.json (F3: pid-proven ports).
  const written = readRuntime();
  if (!written) throw new Error('runtime.json disappeared after successful start');
  return { runtime: written, alreadyRunning: false };
}

/**
 * Read the postmaster.pid file to cross-check the pg port from runtime.json (F3).
 * Returns the pg port if found, or null if the file is absent (older standalone layout).
 */
export function readPostmasterPgPort(dataDir: string): number | null {
  const postmasterPid = `${dataDir}/pgdata/postmaster.pid`;
  if (!existsSync(postmasterPid)) return null;
  try {
    const lines = readFileSync(postmasterPid, 'utf8').split(/\r?\n/);
    // Line 4 (index 3) is the pg port according to the PostgreSQL postmaster.pid format.
    const portStr = lines[3]?.trim();
    if (!portStr) return null;
    const port = Number(portStr);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}
