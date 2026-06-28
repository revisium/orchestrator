







import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { getConfig, isAlive, resolveDefaultGraphqlPort } from '../config.js';
import {
  hostCodeVersion,
  isHostRunning,
  readHostRuntime,
  removeHostRuntime,
  type HostRuntimeState,
} from './host-runtime.js';
import { dbosEnvPin } from './dbos-identity.js';

const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_RECHECK_MS = 20_000;
const POLL_INTERVAL_MS = 300;

export type EnsureHostResult = {
  runtime: HostRuntimeState;
  alreadyRunning: boolean;
};


export function expectedGraphqlPort(): number {
  const env = process.env['REVO_GRAPHQL_PORT'];
  if (env && /^\d+$/.test(env.trim())) return Number(env.trim());
  return resolveDefaultGraphqlPort();
}


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




async function waitForReady(timeoutMs: number): Promise<HostRuntimeState | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runtime = readHostRuntime();
    if (runtime && isAlive(runtime.pid) && (await isGraphqlHealthy(runtime.graphqlPort))) return runtime;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}




export function daemonSpawnArgv(entry: string = process.argv[1]): [string, string[]] {
  const daemonArgs = ['__daemon'];
  if (entry.endsWith('.ts')) {
    return [process.execPath, ['--import', 'tsx', entry, ...daemonArgs]];
  }
  return [process.execPath, [entry, ...daemonArgs]];
}

function spawnDaemon(): void {
  const out = openSync(getConfig().hostLogFile, 'a');
  const [cmd, args] = daemonSpawnArgv();
  const env = { ...process.env, ...dbosEnvPin(getConfig().profile, process.env) };
  const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out], env });
  closeSync(out);
  if (!child.pid) throw new Error('Failed to spawn Revo host daemon: spawn returned no pid');
  child.unref();
}

export type EnsureHostOptions = { timeoutMs?: number; recheckMs?: number };


export async function ensureHost(options: EnsureHostOptions = {}): Promise<EnsureHostResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const existing = readHostRuntime();

  if (existing && isHostRunning()) {
    if (await isGraphqlHealthy(existing.graphqlPort)) {
      if (existing.version !== undefined && existing.version !== hostCodeVersion()) {
        console.warn(
          `[host] attached to a daemon running version ${existing.version}, but this build is ` +
            `${hostCodeVersion()} — run \`revo restart\` to replace the stale daemon.`,
        );
      }
      return { runtime: existing, alreadyRunning: true };
    }
    const ready = await waitForReady(recheckMs);
    if (ready) return { runtime: ready, alreadyRunning: true };
    throw new Error(
      `Revo host daemon (pid ${existing.pid}) is alive but not healthy on GraphQL port ` +
        `${existing.graphqlPort}. Stop it with \`revo stop\` and retry.`,
    );
  }

  if (existing) removeHostRuntime();
  spawnDaemon();
  const ready = await waitForReady(timeoutMs);
  if (!ready) {
    throw new Error(
      `Revo host daemon did not become ready within ${timeoutMs / 1000}s — see \`revo logs\`.`,
    );
  }
  return { runtime: ready, alreadyRunning: false };
}
