import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { findFreePort, getConfig, repoRoot } from '../config.js';
import { resolveDbosDbName } from '../engine/ensure-postgres.js';
import {
  dbosDatabaseUrl,
  postgresDatabaseUrl,
  REVO_PG_ADMIN_DB,
  REVO_PG_PASSWORD,
  REVO_PG_USER,
  assertDistinctDatabaseNames,
  resolveRevoDbName,
  revoProductDatabaseUrl,
} from './revo-database.js';

const require = createRequire(import.meta.url);
const DUPLICATE_DATABASE = '42P04';

export type StorageRuntime = {
  pgPort: number;
  dataDir: string;
  revoDatabaseUrl: string;
  dbosDatabaseUrl: string;
};

let ensurePromise: Promise<StorageRuntime> | undefined;
let activeEmbeddedPostgres: EmbeddedPostgres | undefined;
let activeStorage: StorageRuntime | undefined;

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function canConnect(pgPort: number): Promise<boolean> {
  const client = new pg.Client(postgresDatabaseUrl(REVO_PG_ADMIN_DB, pgPort));
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function ensureDatabase(pgPort: number, database: string): Promise<void> {
  const client = new pg.Client(postgresDatabaseUrl(REVO_PG_ADMIN_DB, pgPort));
  try {
    await client.connect();
    const result = await client.query(
      'SELECT count(*)::text AS count FROM pg_database WHERE datname = $1',
      [database],
    );
    if (result.rows[0]?.count !== '0') return;
    try {
      await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    } catch (err) {
      if ((err as { code?: string }).code !== DUPLICATE_DATABASE) throw err;
    }
  } finally {
    await client.end();
  }
}

function runPrismaMigrations(databaseUrl: string): void {
  const prismaCli = require.resolve('prisma/build/index.js') as string;
  execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}

async function startEmbeddedPostgres(pgPort: number, dataDir: string): Promise<void> {
  if (await canConnect(pgPort)) return;

  const databaseDir = join(dataDir, 'pgdata');
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: REVO_PG_USER,
    password: REVO_PG_PASSWORD,
    port: pgPort,
    persistent: true,
    onLog: (message) => console.error(message.trimEnd()),
    onError: (message) => console.error(message),
  });

  if (!existsSync(join(databaseDir, 'PG_VERSION'))) {
    await embedded.initialise();
  }
  await embedded.start();
  activeEmbeddedPostgres = embedded;
}

async function ensureStorageUncached(): Promise<StorageRuntime> {
  const config = getConfig();
  const pgPort = await canConnect(config.preferredPgPort)
    ? config.preferredPgPort
    : await findFreePort(config.preferredPgPort);
  await startEmbeddedPostgres(pgPort, config.dataDir);

  const revoDb = resolveRevoDbName();
  const dbosDb = resolveDbosDbName();
  assertDistinctDatabaseNames(revoDb, dbosDb);
  await ensureDatabase(pgPort, revoDb);
  await ensureDatabase(pgPort, dbosDb);

  const revoDatabaseUrl = revoProductDatabaseUrl(pgPort);
  process.env['DATABASE_URL'] = revoDatabaseUrl;
  runPrismaMigrations(revoDatabaseUrl);

  activeStorage = {
    pgPort,
    dataDir: config.dataDir,
    revoDatabaseUrl,
    dbosDatabaseUrl: dbosDatabaseUrl(pgPort),
  };
  return activeStorage;
}

export async function ensureStorage(): Promise<StorageRuntime> {
  ensurePromise ??= ensureStorageUncached().catch((error: unknown) => {
    ensurePromise = undefined;
    throw error;
  });
  return ensurePromise;
}

export function getActiveStorage(): StorageRuntime | undefined {
  return activeStorage;
}

export async function shutdownStorage(): Promise<void> {
  const embedded = activeEmbeddedPostgres;
  activeEmbeddedPostgres = undefined;
  activeStorage = undefined;
  ensurePromise = undefined;
  if (!embedded) return;
  await embedded.stop().catch(() => undefined);
}
