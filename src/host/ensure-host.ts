/**
 * ensureHost() — attach-or-spawn the long-lived Revo host daemon (ADR 0006), mirroring the
 * three-state model of ensureRevisium:
 *   1. HEALTHY            → attach, return alreadyRunning=true.
 *   2. ALIVE BUT UNHEALTHY → wait for it to finish booting; never spawn a duplicate (the GraphQL
 *      port would collide), then throw if it stays unhealthy.
 *   3. NO LIVE DAEMON     → spawn detached + unref, wait for GraphQL health.
 *
 * The daemon is the single DBOS owner; this helper is the ONLY way the stack acquires a host.
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, resolveDefaultGraphqlPort } from '../config.js';
import { isHostRunning, readHostRuntime, type HostRuntimeState } from './host-runtime.js';

const DEFAULT_TIMEOUT_MS = 120_000;
/** Budget to let an alive-but-not-yet-healthy daemon finish booting before giving up. */
const DEFAULT_RECHECK_MS = 20_000;
const POLL_INTERVAL_MS = 300;

export type EnsureHostResult = {
  runtime: HostRuntimeState;
  alreadyRunning: boolean;
};

/** The GraphQL port the daemon listens on — must match startGraphqlHost's resolution. */
export function expectedGraphqlPort(): number {
  const env = process.env['REVO_GRAPHQL_PORT'];
  if (env && /^\d+$/.test(env.trim())) return Number(env.trim());
  return resolveDefaultGraphqlPort();
}

/** GraphQL liveness probe: the daemon answers a trivial query on its port. */
export async function isGraphqlHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForGraphqlHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isGraphqlHealthy(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Build the argv to re-invoke THIS CLI as the detached daemon. Handles dev (tsx running the `.ts`
 * source — node needs the tsx loader) vs prod (node running the compiled `.js` entry directly).
 * `entry` defaults to this process's script; it is a parameter so the dev/prod split is unit-testable.
 */
export function daemonSpawnArgv(entry: string = process.argv[1]): [string, string[]] {
  const daemonArgs = ['system', '__daemon'];
  if (entry.endsWith('.ts')) {
    return [process.execPath, ['--import', 'tsx', entry, ...daemonArgs]];
  }
  return [process.execPath, [entry, ...daemonArgs]];
}

function spawnDaemon(): void {
  const out = openSync(join(getConfig().dataDir, 'host.log'), 'a');
  const [cmd, args] = daemonSpawnArgv();
  // env inheritance carries the resolved profile (REVO_PROFILE / REVO_* knobs) to the daemon.
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out], env: process.env });
  closeSync(out);
  if (!child.pid) throw new Error('Failed to spawn Revo host daemon: spawn returned no pid');
  child.unref(); // detached — the daemon outlives this CLI process
}

export type EnsureHostOptions = { timeoutMs?: number; recheckMs?: number };

export async function ensureHost(options: EnsureHostOptions = {}): Promise<EnsureHostResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const port = expectedGraphqlPort();
  const existing = readHostRuntime();

  if (existing && isHostRunning()) {
    if (await isGraphqlHealthy(existing.graphqlPort)) {
      return { runtime: existing, alreadyRunning: true };
    }
    // Alive but unhealthy — likely mid-boot. Wait rather than spawn a duplicate (port collision).
    if (await waitForGraphqlHealth(existing.graphqlPort, recheckMs)) {
      const ready = readHostRuntime();
      if (ready) return { runtime: ready, alreadyRunning: true };
    }
    throw new Error(
      `Revo host daemon (pid ${existing.pid}) is alive but not healthy on GraphQL port ` +
        `${existing.graphqlPort}. Stop it with \`revo stop\` and retry.`,
    );
  }

  spawnDaemon();
  if (!(await waitForGraphqlHealth(port, timeoutMs))) {
    throw new Error(
      `Revo host daemon did not become healthy on GraphQL port ${port} within ${timeoutMs / 1000}s` +
        ' — see `revo logs`.',
    );
  }
  const written = readHostRuntime();
  if (!written) throw new Error('host.json missing after the daemon reported healthy');
  return { runtime: written, alreadyRunning: false };
}
