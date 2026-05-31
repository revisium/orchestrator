import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export type RuntimeState = {
  httpPort: number;
  pgPort: number;
  pid: number;
  startedAt: string;
};

type ConfigFile = {
  host: string;
  preferredPort: number;
  preferredPgPort: number;
  autoDiscover: boolean;
  dataDir: string;
  org: string;
  project: string;
  branch: string;
};

const cliDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(cliDir, '..', '..');

function expandHome(path: string): string {
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return join(os.homedir(), path.slice(2));
  return path;
}

function loadConfig(): ConfigFile {
  const configPath = join(repoRoot, 'revisium.config.json');
  return JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFile;
}

const rawConfig = loadConfig();

export const host = rawConfig.host;
export const preferredPort = rawConfig.preferredPort;
export const preferredPgPort = rawConfig.preferredPgPort;
export const autoDiscover = rawConfig.autoDiscover;
export const dataDir = expandHome(rawConfig.dataDir);
export const org = rawConfig.org;
export const project = rawConfig.project;
export const branch = rawConfig.branch;
export const logFile = join(dataDir, 'standalone.log');
export const runtimeFile = join(dataDir, 'runtime.json');

mkdirSync(dataDir, { recursive: true });

export function readRuntime(): RuntimeState | null {
  if (!existsSync(runtimeFile)) return null;

  try {
    return JSON.parse(readFileSync(runtimeFile, 'utf8')) as RuntimeState;
  } catch {
    return null;
  }
}

export function removeRuntime(): void {
  if (existsSync(runtimeFile)) rmSync(runtimeFile);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function baseUrl(port: number): string {
  return `http://${host}:${port}`;
}

export function healthUrl(port: number): string {
  return `${baseUrl(port)}/api`;
}

export function revisiumUri(port: number): string {
  return `revisium://${host}:${port}/${org}/${project}/${branch}`;
}

export async function resolvePorts(): Promise<{ httpPort: number; pgPort: number }> {
  const runtime = readRuntime();
  if (runtime && isAlive(runtime.pid)) {
    return { httpPort: runtime.httpPort, pgPort: runtime.pgPort };
  }

  return { httpPort: preferredPort, pgPort: preferredPgPort };
}

export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.once('error', () => resolvePort(false));
    srv.once('listening', () => srv.close(() => resolvePort(true)));
    srv.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(from: number): Promise<number> {
  for (let p = from; p < from + 200; p += 1) {
    if (await isPortFree(p)) return p;
  }

  throw new Error(`No free port found from ${from}`);
}

export async function isHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(healthUrl(port), { signal: AbortSignal.timeout(3000) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}
