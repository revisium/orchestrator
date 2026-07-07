import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

export type DefaultConfig = {
  host: string;
  preferredPort: number;
  preferredPgPort: number;
  dataDir: string;
  org: string;
  project: string;
  branch: string;
};

export const DEFAULT_CONFIG = {
  host: 'localhost',
  preferredPort: 19222,
  preferredPgPort: 15440,
  dataDir: '~/.revo',
  org: 'admin',
  project: 'control-plane',
  branch: 'master',
} as const satisfies DefaultConfig;

export const PROFILES = {
  default: { suffix: '', portOffset: 0, dbosDb: 'dbos', revoDb: 'revo' },
  dev: { suffix: '-dev', portOffset: 400, dbosDb: 'dbos_dev', revoDb: 'revo_dev' },
} as const;

export type ProfileName = keyof typeof PROFILES;

export type RevoConfig = DefaultConfig & {
  dataDir: string;
  profile: ProfileName;
  hostLogFile: string;
};

export const GRAPHQL_PORT_OFFSET = 1;

const sourceDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(sourceDir, '..');

function expandHome(path: string): string {
  if (path === '~') return os.homedir();
  if (path.startsWith('~/')) return join(os.homedir(), path.slice(2));
  return path;
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
  return expandHome(`${DEFAULT_CONFIG.dataDir}${PROFILES[profile].suffix}`);
}

export function resolveProfileConfig(
  raw: Pick<DefaultConfig, 'dataDir' | 'preferredPort' | 'preferredPgPort'>,
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

  const rawConfig = DEFAULT_CONFIG;
  const { profile, dataDir: profileDataDir, preferredPort, preferredPgPort } = resolveProfileConfig(rawConfig);
  const dataDir = expandHome(profileDataDir);
  mkdirSync(dataDir, { recursive: true });

  cachedConfig = {
    ...rawConfig,
    project: process.env['REVO_PROJECT'] ?? rawConfig.project,
    branch: process.env['REVO_BRANCH'] ?? rawConfig.branch,
    profile,
    dataDir,
    preferredPort,
    preferredPgPort,
    hostLogFile: join(dataDir, 'host.log'),
  };

  return cachedConfig;
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

export function resolveDefaultGraphqlPort(): number {
  const basePort = getConfig().preferredPort;
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
