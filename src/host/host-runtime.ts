/**
 * Host daemon runtime file (`host.json`) — the tracked identity of the long-lived Revo/NestJS
 * host daemon, the single DBOS owner (ADR 0006). It lives beside the standalone `runtime.json`
 * in the profile data dir but is a SEPARATE file: the standalone daemon and the host daemon have
 * independent lifecycles, so conflating them would let one's stale pid mask the other's state.
 *
 * Shape is intentionally minimal — only what `ensureHost`/`status`/clients need: the pid to prove
 * liveness, the GraphQL port that is the client transport, and the profile/startedAt for display
 * and compare-and-delete identity. Standalone HTTP/pg ports stay in `runtime.json` (readRuntime).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, isAlive, profileDataDir, PROFILES, type ProfileName } from '../config.js';

export type HostRuntimeState = {
  pid: number;
  graphqlPort: number;
  /** Local port of the daemon's MCP (StreamableHTTP) endpoint that `revo mcp` bridges to. */
  mcpPort: number;
  startedAt: string;
  profile: string;
  /** Build version this daemon runs (slice 139). Absent in host.json written before 139. */
  version?: string;
};

let cachedCodeVersion: string | undefined;

/**
 * This build's package version (e.g. `0.1.0-alpha.7`). Recorded in host.json so `ensureHost`/`doctor`
 * can detect a stale daemon running a DIFFERENT build than the current install (slice 139). A `0.0.0`
 * dev checkout does not change across rebuilds, so dev relies on `revo restart`; released builds differ.
 */
export function hostCodeVersion(): string {
  if (cachedCodeVersion === undefined) {
    try {
      const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown };
      cachedCodeVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
    } catch {
      cachedCodeVersion = 'unknown';
    }
  }
  return cachedCodeVersion;
}

/** Identity used for compare-and-delete (mirrors the standalone runtime guard — F19/F21). */
export type HostRuntimeSnapshot = Pick<HostRuntimeState, 'pid' | 'startedAt'>;

export function hostRuntimeFile(): string {
  return join(getConfig().dataDir, 'host.json');
}

export function readHostRuntime(): HostRuntimeState | null {
  return readHostRuntimeAt(hostRuntimeFile());
}

/** Read+parse a host.json at an ARBITRARY path (a sibling profile's). Null when absent/corrupt. */
export function readHostRuntimeAt(file: string): HostRuntimeState | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HostRuntimeState;
  } catch {
    return null;
  }
}

/**
 * Live tracked daemon pids across ALL profiles (slice 140 Phase 2). The rogue reaper must protect
 * EVERY profile's daemon tree, not just the active one — else `revo stop --all --profile default`
 * would SIGKILL a live `dev` daemon (and its bridges), aborting that profile's in-flight DBOS work.
 * Band-default dirs only (a custom REVO_DATA_DIR layout isn't enumerable; documented in profileDataDir).
 */
export function allTrackedHostPids(): number[] {
  const pids: number[] = [];
  for (const profile of Object.keys(PROFILES) as ProfileName[]) {
    const runtime = readHostRuntimeAt(join(profileDataDir(profile), 'host.json'));
    if (runtime && isAlive(runtime.pid)) pids.push(runtime.pid);
  }
  return pids;
}

export function writeHostRuntime(state: HostRuntimeState): void {
  writeFileSync(hostRuntimeFile(), JSON.stringify(state, null, 2));
}

export function removeHostRuntime(): void {
  const file = hostRuntimeFile();
  if (existsSync(file)) rmSync(file);
}

/**
 * Remove `host.json` ONLY if the file on disk still matches the snapshot (same pid AND startedAt).
 * A replaced file (a concurrently-started daemon) or an already-removed file is a safe no-op — so
 * cleanup can never delete a runtime that belongs to another daemon (compare-and-delete).
 */
export function removeHostRuntimeIfMatches(snapshot: HostRuntimeSnapshot): void {
  const current = readHostRuntime();
  if (current?.pid === snapshot.pid && current?.startedAt === snapshot.startedAt) {
    removeHostRuntime();
  }
}

/** True when `host.json` records a daemon whose pid is still alive (liveness, not health). */
export function isHostRunning(): boolean {
  const runtime = readHostRuntime();
  return runtime !== null && isAlive(runtime.pid);
}
