

























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


const DEFAULT_TIMEOUT_MS = 120_000;

const DEFAULT_RECHECK_MS = 20_000;



type RuntimeSnapshot = Pick<RuntimeState, 'pid' | 'startedAt'>;











export function removeRuntimeIfMatches(snapshot: RuntimeSnapshot): void {
  const current = readRuntime();
  if (current?.pid === snapshot.pid && current?.startedAt === snapshot.startedAt) {
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

  timeoutMs?: number;

  recheckMs?: number;
};


export type RuntimeStateClass = 'healthy' | 'no-live-daemon' | 'alive-unhealthy';








export type RuntimeAction =
  | 'return-running'
  | 'repoll'
  | 'throw-unhealthy'
  | 'remove-and-spawn'
  | 'spawn';














export type RuntimeDecision = {
  action: RuntimeAction;

  shouldRemove: boolean;
};

















export function decideRuntimeAction(
  stalePidSnapshot: RuntimeState | null,
  recheck: RuntimeState | null,
  recheckAlive: boolean,
  recheckHealthy: boolean,
): RuntimeDecision {
  if (recheck && recheckAlive) {
    if (recheckHealthy) return { action: 'return-running', shouldRemove: false };
    return { action: 'repoll', shouldRemove: false };
  }

  if (stalePidSnapshot !== null) {
    const matchesSnapshot =
      recheck !== null &&
      recheck.pid === stalePidSnapshot.pid &&
      recheck.startedAt === stalePidSnapshot.startedAt;
    return { action: 'remove-and-spawn', shouldRemove: matchesSnapshot };
  }
  return { action: 'spawn', shouldRemove: false };
}














export function classifyRuntimeState(
  rt: RuntimeState | null,
  alive: boolean,
  healthy: boolean,
): RuntimeStateClass {
  if (!rt || !alive) return 'no-live-daemon';
  if (healthy) return 'healthy';
  return 'alive-unhealthy';
}






async function handleAliveUnhealthy(rt: RuntimeState, recheckMs: number): Promise<EnsureResult> {
  const becameHealthy = await waitHealthy(healthUrl(rt.httpPort), recheckMs);
  if (becameHealthy) {
    const freshRt = readRuntime();
    if (!freshRt) throw new Error('runtime.json disappeared during re-poll');
    return { runtime: freshRt, alreadyRunning: true };
  }
  throw new Error(
    `Revisium (pid ${rt.pid}) is running but unhealthy — run \`revo revisium stop\` and retry`,
  );
}



async function recheckRepoll(rtRecheck: RuntimeState, recheckMs: number): Promise<EnsureResult> {
  const becameHealthy = await waitHealthy(healthUrl(rtRecheck.httpPort), recheckMs);
  if (becameHealthy) {
    const freshRt = readRuntime();
    if (!freshRt) throw new Error('runtime.json disappeared during recheck re-poll');
    return { runtime: freshRt, alreadyRunning: true };
  }
  throw new Error(
    `Revisium (pid ${rtRecheck.pid}) is running but unhealthy — run \`revo revisium stop\` and retry`,
  );
}

type SpawnConfig = {
  httpPort: number;
  pgPort: number;
  dataDir: string;
  logFile: string;
  runtimeFile: string;
};







async function startAndWaitForHealth(cfg: SpawnConfig, timeoutMs: number): Promise<EnsureResult> {
  const { httpPort, pgPort, dataDir, logFile, runtimeFile } = cfg;
  const entry = require.resolve('@revisium/standalone/bin/revisium-standalone.js') as string;
  const out = openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [entry, '--port', String(httpPort), '--pg-port', String(pgPort), '--data', dataDir],
    { detached: true, stdio: ['ignore', out, out] },
  );
  closeSync(out);

  if (!child.pid) {
    throw new Error('Failed to start standalone Revisium: spawn returned no pid');
  }

  child.unref();

  const spawnStartedAt = new Date().toISOString();
  writeFileSync(
    runtimeFile,
    JSON.stringify({ httpPort, pgPort, pid: child.pid, startedAt: spawnStartedAt, dataDir }, null, 2),
  );

  const spawnSnapshot = { pid: child.pid, startedAt: spawnStartedAt };
  const spawnHealthy = await waitHealthy(healthUrl(httpPort), timeoutMs);
  if (!spawnHealthy) {
    const logTail = tailLines(logFile, 20);
    killTree(child.pid, 'SIGTERM');
    await waitForExit(child.pid, 20_000);
    if (isAlive(child.pid)) killTree(child.pid, 'SIGKILL');
    removeRuntimeIfMatches(spawnSnapshot);
    throw new Error(
      `Revisium did not become healthy on ${baseUrl(httpPort)} within ${timeoutMs / 1000}s` +
        ` — see \`revo revisium logs\`\n${logTail}`,
    );
  }

  const written = readRuntime();
  if (!written) throw new Error('runtime.json disappeared after successful start');
  return { runtime: written, alreadyRunning: false };
}











export async function ensureRevisium(
  options: EnsureRevisiumOptions = {},
): Promise<EnsureResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, recheckMs = DEFAULT_RECHECK_MS } = options;
  const config = getConfig();
  const rt = readRuntime();
  const alive = rt ? isAlive(rt.pid) : false;
  const healthy = rt && alive ? await isHealthy(rt.httpPort) : false;
  const stateClass = classifyRuntimeState(rt, alive, healthy);

  if (stateClass === 'healthy') {
    return { runtime: rt!, alreadyRunning: true };
  }

  if (stateClass === 'alive-unhealthy') {
    return handleAliveUnhealthy(rt!, recheckMs);
  }

  const rtRecheck = readRuntime();
  const recheckAlive = rtRecheck ? isAlive(rtRecheck.pid) : false;
  const recheckHealthy = rtRecheck && recheckAlive ? await isHealthy(rtRecheck.httpPort) : false;
  const decision = decideRuntimeAction(rt, rtRecheck, recheckAlive, recheckHealthy);

  if (decision.action === 'return-running') {
    return { runtime: rtRecheck!, alreadyRunning: true };
  }

  if (decision.action === 'repoll') {
    return recheckRepoll(rtRecheck!, recheckMs);
  }

  if (decision.shouldRemove) removeRuntimeIfMatches(rtRecheck!);

  const httpPort = await findFreePort(parsePort(options.port, config.preferredPort));
  let pgPort = await findFreePort(parsePort(options.pgPort, config.preferredPgPort));
  if (pgPort === httpPort) {
    pgPort = await findFreePort(httpPort + 1);
  }
  const dataDir = options.data ?? config.dataDir;

  return startAndWaitForHealth(
    { httpPort, pgPort, dataDir, logFile: config.logFile, runtimeFile: config.runtimeFile },
    timeoutMs,
  );
}


const MAX_TCP_PORT = 65535;





export function readPostmasterPgPort(dataDir: string): number | null {
  const postmasterPid = `${dataDir}/pgdata/postmaster.pid`;
  if (!existsSync(postmasterPid)) return null;
  try {
    const lines = readFileSync(postmasterPid, 'utf8').split(/\r?\n/);
    const portStr = lines[3]?.trim();
    if (!portStr) return null;
    const port = Number(portStr);
    return Number.isInteger(port) && port > 0 && port <= MAX_TCP_PORT ? port : null;
  } catch {
    return null;
  }
}
