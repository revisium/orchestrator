















import pg from 'pg';
import { PROFILES, resolveProfileName } from '../config.js';





export function resolveDbosDbName(): string {
  const name = process.env['REVO_DBOS_DB'] ?? PROFILES[resolveProfileName()].dbosDb;
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid REVO_DBOS_DB '${name}': must be a SQL identifier (/^[a-z_][a-z0-9_]*$/i)`);
  }
  return name;
}
const MAINTENANCE_DB = 'postgres';


const PG_SQLSTATE_DUPLICATE_DATABASE = '42P04';

export type PostgresCredentials = {
  user: string;
  password: string;
  adminDb: string;
};

const DEFAULT_CREDS: PostgresCredentials = {
  user: 'revisium',
  password: 'password',
  adminDb: MAINTENANCE_DB,
};



export interface ClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: { count: string }[] }>;
  end(): Promise<void>;
}


export type EnsurePostgresDeps = {

  createClient?: () => ClientLike;
};





export async function ensurePostgres(
  pgPort: number,
  opts: Partial<PostgresCredentials> = {},
  deps: EnsurePostgresDeps = {},
): Promise<void> {
  const dbosDbName = resolveDbosDbName();
  const { user, password, adminDb } = { ...DEFAULT_CREDS, ...opts };
  const pgClientFactory = (): ClientLike =>
    new pg.Client({ host: 'localhost', port: pgPort, user, password, database: adminDb }) as unknown as ClientLike;
  const createClient = deps.createClient ?? pgClientFactory;

  const client = createClient();

  try {
    await client.connect();
    const result = await client.query(
      `SELECT count(*)::text AS count FROM pg_database WHERE datname = $1`,
      [dbosDbName],
    );
    const exists = result.rows[0]?.count !== '0';
    if (!exists) {
      try {
        await client.query(`CREATE DATABASE ${dbosDbName}`);
      } catch (err) {
        if ((err as { code?: string }).code === PG_SQLSTATE_DUPLICATE_DATABASE) {
          return;
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}








export function dbosSystemDatabaseUrl(
  pgPort: number,
  user = 'revisium',
  password = 'password',
): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${pgPort}/${resolveDbosDbName()}`;
}
