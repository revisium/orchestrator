import { getConfig, PROFILES, resolveProfileName } from '../config.js';
import { resolveDbosDbName } from '../engine/ensure-postgres.js';

export const REVO_PG_USER = 'revisium';
export const REVO_PG_PASSWORD = 'password';
export const REVO_PG_ADMIN_DB = 'postgres';

const RESERVED_DATABASE_NAMES = new Set(['postgres', 'template0', 'template1']);
const MAX_DATABASE_IDENTIFIER_BYTES = 63;

export function assertSqlIdentifier(name: string, source: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid ${source} '${name}': must be a SQL identifier (/^[a-z_][a-z0-9_]*$/i)`);
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_DATABASE_IDENTIFIER_BYTES) {
    throw new Error(`Invalid ${source} '${name}': must be <= ${MAX_DATABASE_IDENTIFIER_BYTES} bytes`);
  }
  if (RESERVED_DATABASE_NAMES.has(name.toLowerCase())) {
    throw new Error(`Invalid ${source} '${name}': reserved PostgreSQL database name`);
  }
  return name;
}

export function resolveRevoDbName(): string {
  return assertSqlIdentifier(
    process.env['REVO_DB'] ?? PROFILES[resolveProfileName()].revoDb,
    'REVO_DB',
  );
}

export function assertDistinctDatabaseNames(revoDb: string, dbosDb: string): void {
  if (revoDb === dbosDb) {
    throw new Error(`Invalid storage database configuration: REVO_DB and REVO_DBOS_DB must differ (${revoDb})`);
  }
}

export function postgresDatabaseUrl(
  database: string,
  pgPort: number = getConfig().preferredPgPort,
  user = REVO_PG_USER,
  password = REVO_PG_PASSWORD,
): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${pgPort}/${database}`;
}

export function revoProductDatabaseUrl(pgPort: number): string {
  return postgresDatabaseUrl(resolveRevoDbName(), pgPort);
}

export function dbosDatabaseUrl(pgPort: number): string {
  return postgresDatabaseUrl(resolveDbosDbName(), pgPort);
}
