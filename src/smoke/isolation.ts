import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type RawConfig = {
  preferredPort: number;
  preferredPgPort: number;
  dataDir: string;
};

export type SmokeIsolationOptions = {
  scriptName: string;
  requireGraphqlPort?: boolean;
};

export type SmokeIsolation = {
  scriptName: string;
  dataDir: string;
  httpPort: number;
  pgPort: number;
  dbosDb: string;
  graphqlPort?: number;
};

const sourceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sourceDir, '..', '..');
const configPath = join(repoRoot, 'revisium.config.json');
const DEFAULT_GRAPHQL_PORT_OFFSET = 1;

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function loadRawConfig(): RawConfig {
  return JSON.parse(readFileSync(configPath, 'utf8')) as RawConfig;
}

function parseRequiredPort(name: string, disallowed: Map<number, string>): number {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required for state-touching smoke scripts`);
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a TCP port, got ${raw}`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`${name} must be a TCP port, got ${raw}`);
  }
  const reason = disallowed.get(port);
  if (reason) {
    throw new Error(`${name} must not use ${reason} (${port})`);
  }
  return port;
}

function assertTempDataDir(dataDir: string, defaultDataDir: string): string {
  const resolved = resolve(expandHome(dataDir));
  const resolvedDefault = resolve(expandHome(defaultDataDir));
  if (resolved === resolvedDefault) {
    throw new Error(`REVO_DATA_DIR must not use default production data dir ${defaultDataDir}`);
  }

  const tempRoots = [resolve(tmpdir()), '/tmp', '/private/tmp'];
  if (!tempRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error(`REVO_DATA_DIR must be a temp task-specific path, got ${resolved}`);
  }
  if (basename(resolved) === basename(resolve(tmpdir())) || resolved === resolve(tmpdir())) {
    throw new Error(`REVO_DATA_DIR must be task-specific, got temp root ${resolved}`);
  }
  return resolved;
}

function parseRequiredDbosDb(): string {
  const dbosDb = process.env.REVO_DBOS_DB;
  if (!dbosDb) throw new Error('REVO_DBOS_DB is required for state-touching smoke scripts');
  if (dbosDb === 'dbos') throw new Error('REVO_DBOS_DB must not use default production database dbos');
  if (!/^[a-z_][a-z0-9_]*$/i.test(dbosDb)) {
    throw new Error(`Invalid REVO_DBOS_DB '${dbosDb}': must be a SQL identifier`);
  }
  return dbosDb;
}

export function resolveSmokeIsolation(options: SmokeIsolationOptions): SmokeIsolation {
  const rawConfig = loadRawConfig();
  const rawDataDir = process.env.REVO_DATA_DIR;
  if (!rawDataDir) throw new Error('REVO_DATA_DIR is required for state-touching smoke scripts');

  const dataDir = assertTempDataDir(rawDataDir, rawConfig.dataDir);
  const httpPort = parseRequiredPort('REVO_PORT', new Map([[rawConfig.preferredPort, 'default production HTTP port']]));
  const pgPort = parseRequiredPort('REVO_PG_PORT', new Map([[rawConfig.preferredPgPort, 'default production PostgreSQL port']]));
  const dbosDb = parseRequiredDbosDb();

  let graphqlPort: number | undefined;
  if (options.requireGraphqlPort) {
    graphqlPort = parseRequiredPort(
      'REVO_GRAPHQL_PORT',
      new Map([
        [rawConfig.preferredPort + DEFAULT_GRAPHQL_PORT_OFFSET, 'default-derived production GraphQL port'],
        [httpPort + DEFAULT_GRAPHQL_PORT_OFFSET, 'implicit derived GraphQL port'],
      ]),
    );
  }

  return {
    scriptName: options.scriptName,
    dataDir,
    httpPort,
    pgPort,
    dbosDb,
    ...(graphqlPort !== undefined ? { graphqlPort } : {}),
  };
}

export function printSmokeIsolation(isolation: SmokeIsolation): void {
  console.log(`smokeIsolationScript=${isolation.scriptName}`);
  console.log(`smokeIsolationDataDir=${isolation.dataDir}`);
  console.log(`smokeIsolationHttpPort=${isolation.httpPort}`);
  console.log(`smokeIsolationPgPort=${isolation.pgPort}`);
  console.log(`smokeIsolationDbosDb=${isolation.dbosDb}`);
  if (isolation.graphqlPort !== undefined) {
    console.log(`smokeIsolationGraphqlPort=${isolation.graphqlPort}`);
  }
}

export function assertSmokeIsolation(options: SmokeIsolationOptions): SmokeIsolation {
  const isolation = resolveSmokeIsolation(options);
  printSmokeIsolation(isolation);
  return isolation;
}

export function guardSmokeIsolation(options: SmokeIsolationOptions): SmokeIsolation {
  try {
    return assertSmokeIsolation(options);
  } catch (error) {
    console.error(`Smoke isolation guard failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
