/**
 * ensurePostgres() — creates the `dbos` database in Revisium's embedded Postgres if absent.
 *
 * Idempotent: checks pg_database first; only issues CREATE DATABASE when absent.
 * Uses the pid-proven pg port from runtime.json (never hardcodes it — ADR-0001 #4).
 *
 * PG creds default: `revisium`/`password` — confirmed from @revisium/standalone 2.8.2 (F5).
 * Kept parameterized so a future config change is one line.
 *
 * Race safety (F17): Two concurrent first-run hosts may both observe count=0 and both issue
 * CREATE DATABASE. PostgreSQL raises SQLSTATE 42P04 (duplicate_database) for the loser.
 * We catch 42P04 and treat it as success — the database now exists, which is the desired
 * postcondition. All other errors are re-thrown verbatim.
 *
 * Testability (F20): ensurePostgres accepts an optional `deps.createClient` factory so tests
 * can inject a fake client that exercises the real 42P04 catch / SELECT fast-path without a
 * live Postgres. The production default constructs a real `pg.Client`.
 */
import pg from 'pg';

/**
 * DBOS system-database name. Overridable via `REVO_DBOS_DB` so the e2e/CI daemon keeps its DBOS
 * progress fully separate from the dev one. Validated to a safe identifier because the name is
 * interpolated into a non-parameterizable `CREATE DATABASE` (CREATE DATABASE cannot bind params).
 */
function resolveDbosDbName(): string {
  const name = process.env['REVO_DBOS_DB'] ?? 'dbos';
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid REVO_DBOS_DB '${name}': must be a SQL identifier (/^[a-z_][a-z0-9_]*$/i)`);
  }
  return name;
}

const DBOS_DB_NAME = resolveDbosDbName();
const MAINTENANCE_DB = 'postgres';

/** PostgreSQL SQLSTATE for "database already exists" (duplicate_database). */
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

/**
 * Minimal pg client interface required by ensurePostgres (F20).
 * Allows injecting a fake in tests without pulling in the real pg driver.
 */
export interface ClientLike {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: { count: string }[] }>;
  end(): Promise<void>;
}

/** Injectable dependencies for ensurePostgres (F20). */
export type EnsurePostgresDeps = {
  /** Factory that returns a ClientLike. Defaults to constructing a real pg.Client. */
  createClient?: () => ClientLike;
};

/**
 * Ensure the `dbos` database exists on the Revisium embedded Postgres.
 * @param pgPort - The pid-proven pg port from runtime.json.
 * @param opts   - Optional credential overrides (default: revisium/password).
 * @param deps   - Optional injectable dependencies for testing (F20).
 */
export async function ensurePostgres(
  pgPort: number,
  opts: Partial<PostgresCredentials> = {},
  deps: EnsurePostgresDeps = {},
): Promise<void> {
  const { user, password, adminDb } = { ...DEFAULT_CREDS, ...opts };
  // pg.Client.connect() returns Promise<Client> while ClientLike.connect() returns
  // Promise<void>; they are structurally compatible at the call sites used here, but
  // TypeScript requires an explicit cast via unknown to bridge the return-type difference.
  const pgClientFactory = (): ClientLike =>
    new pg.Client({ host: 'localhost', port: pgPort, user, password, database: adminDb }) as unknown as ClientLike;
  const createClient = deps.createClient ?? pgClientFactory;

  const client = createClient();

  try {
    await client.connect();
    const result = await client.query(
      `SELECT count(*)::text AS count FROM pg_database WHERE datname = $1`,
      [DBOS_DB_NAME],
    );
    const exists = result.rows[0]?.count !== '0';
    if (!exists) {
      // CREATE DATABASE cannot be parameterized; `dbos` is a fixed literal with no injection surface.
      // Race backstop (F17): if two hosts both observed count=0 and both issue CREATE DATABASE,
      // PostgreSQL raises 42P04 (duplicate_database) for the loser. Treat it as success
      // (idempotent — the database now exists). Re-throw any other error.
      try {
        await client.query(`CREATE DATABASE ${DBOS_DB_NAME}`);
      } catch (err) {
        if ((err as { code?: string }).code === PG_SQLSTATE_DUPLICATE_DATABASE) {
          // Another concurrent host already created it — this is fine.
          return;
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
}

/**
 * Build the DBOS system database URL from the pid-proven pg port.
 * Single place; never hardcodes the port.
 *
 * CR4: user and password are percent-encoded via encodeURIComponent so that
 * reserved characters (e.g. '@', ':', '/', '%') do not break the URI.
 * The default credentials ('revisium'/'password') contain no reserved chars
 * and encode to themselves, so existing behaviour is unchanged.
 */
export function dbosSystemDatabaseUrl(
  pgPort: number,
  user = 'revisium',
  password = 'password',
): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${pgPort}/${DBOS_DB_NAME}`;
}
