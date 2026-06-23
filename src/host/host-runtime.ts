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
import { getConfig, isAlive } from '../config.js';

export type HostRuntimeState = {
  pid: number;
  graphqlPort: number;
  startedAt: string;
  profile: string;
};

/** Identity used for compare-and-delete (mirrors the standalone runtime guard — F19/F21). */
export type HostRuntimeSnapshot = Pick<HostRuntimeState, 'pid' | 'startedAt'>;

export function hostRuntimeFile(): string {
  return join(getConfig().dataDir, 'host.json');
}

export function readHostRuntime(): HostRuntimeState | null {
  const file = hostRuntimeFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as HostRuntimeState;
  } catch {
    return null;
  }
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
