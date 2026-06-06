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
  /** Data directory used by the standalone daemon. Written by ensureRevisium(). */
  dataDir?: string;
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

export type RevoConfig = ConfigFile & {
  dataDir: string;
  logFile: string;
  runtimeFile: string;
};

const sourceDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(sourceDir, '..');

function expandHome(path: string): string {
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return join(os.homedir(), path.slice(2));
  return path;
}

function loadConfig(): ConfigFile {
  const configPath = join(repoRoot, 'revisium.config.json');
  return JSON.parse(readFileSync(configPath, 'utf8')) as ConfigFile;
}

let cachedConfig: RevoConfig | null = null;

export function getConfig(): RevoConfig {
  if (cachedConfig) return cachedConfig;

  const rawConfig = loadConfig();
  const dataDir = expandHome(rawConfig.dataDir);
  mkdirSync(dataDir, { recursive: true });

  cachedConfig = {
    ...rawConfig,
    dataDir,
    logFile: join(dataDir, 'standalone.log'),
    runtimeFile: join(dataDir, 'runtime.json'),
  };

  return cachedConfig;
}

export function readRuntime(): RuntimeState | null {
  const { runtimeFile } = getConfig();
  if (!existsSync(runtimeFile)) return null;

  try {
    return JSON.parse(readFileSync(runtimeFile, 'utf8')) as RuntimeState;
  } catch {
    return null;
  }
}

export function removeRuntime(): void {
  const { runtimeFile } = getConfig();
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
  const { host } = getConfig();
  return `http://${host}:${port}`;
}

export function healthUrl(port: number): string {
  return `${baseUrl(port)}/api`;
}

export function revisiumUri(port: number): string {
  const { host, org, project, branch } = getConfig();
  return `revisium://${host}:${port}/${org}/${project}/${branch}`;
}

export async function resolvePorts(): Promise<{ httpPort: number; pgPort: number }> {
  const runtime = readRuntime();
  if (runtime && isAlive(runtime.pid)) {
    return { httpPort: runtime.httpPort, pgPort: runtime.pgPort };
  }

  const { preferredPort, preferredPgPort } = getConfig();
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
