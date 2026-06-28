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





export const PROFILES = {
  default: { suffix: '', portOffset: 0, dbosDb: 'dbos' },
  dev: { suffix: '-dev', portOffset: 400, dbosDb: 'dbos_dev' },
} as const;

export type ProfileName = keyof typeof PROFILES;

export type RevoConfig = ConfigFile & {
  dataDir: string;
  profile: ProfileName;
  logFile: string;
  hostLogFile: string;
  runtimeFile: string;
};

export const GRAPHQL_PORT_OFFSET = 1;

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


function numEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}


export function resolveProfileName(env: NodeJS.ProcessEnv = process.env): ProfileName {
  const raw = env['REVO_PROFILE'];
  if (!raw) return 'default';
  if (Object.prototype.hasOwnProperty.call(PROFILES, raw)) return raw as ProfileName;
  throw new Error(
    `Unknown REVO_PROFILE '${raw}'. Known profiles: ${Object.keys(PROFILES).join(', ')}. ` +
      'Set REVO_DATA_DIR/REVO_PORT/REVO_PG_PORT/REVO_DBOS_DB explicitly for a custom layout.',
  );
}

export type ProfileConfig = {
  profile: ProfileName;
  dataDir: string;
  preferredPort: number;
  preferredPgPort: number;
};





export function profileDataDir(profile: ProfileName): string {
  return expandHome(`${loadConfig().dataDir}${PROFILES[profile].suffix}`);
}



export function resolveProfileConfig(
  raw: Pick<ConfigFile, 'dataDir' | 'preferredPort' | 'preferredPgPort'>,
  env: NodeJS.ProcessEnv = process.env,
): ProfileConfig {
  const profile = resolveProfileName(env);
  const band = PROFILES[profile];
  return {
    profile,
    dataDir: env['REVO_DATA_DIR'] ?? `${raw.dataDir}${band.suffix}`,
    preferredPort: numEnv('REVO_PORT', env) ?? raw.preferredPort + band.portOffset,
    preferredPgPort: numEnv('REVO_PG_PORT', env) ?? raw.preferredPgPort + band.portOffset,
  };
}






export function getConfig(): RevoConfig {
  if (cachedConfig) return cachedConfig;

  const rawConfig = loadConfig();
  const { profile, dataDir: profileDataDir, preferredPort, preferredPgPort } = resolveProfileConfig(rawConfig);
  const dataDir = expandHome(profileDataDir);
  mkdirSync(dataDir, { recursive: true });

  cachedConfig = {
    ...rawConfig,
    profile,
    dataDir,
    preferredPort,
    preferredPgPort,
    logFile: join(dataDir, 'standalone.log'),
    hostLogFile: join(dataDir, 'host.log'),
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

export function resolveDefaultGraphqlPort(): number {
  const runtime = readRuntime();
  const basePort = runtime && isAlive(runtime.pid)
    ? runtime.httpPort
    : getConfig().preferredPort;
  if (!Number.isInteger(basePort) || basePort <= 0 || basePort > 65_535) {
    throw new Error(`Cannot derive GraphQL port from invalid HTTP port ${basePort}`);
  }
  const port = basePort + GRAPHQL_PORT_OFFSET;
  if (port > 65_535) {
    throw new Error(`Cannot derive GraphQL port from HTTP port ${basePort}`);
  }
  return port;
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
