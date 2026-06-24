/**
 * Daemon singleton gate (slice 139). Exactly ONE host daemon per profile may own — and therefore poll
 * — the `dev-tasks` WorkflowQueue. Ownership is a connection-scoped Postgres ADVISORY LOCK:
 *
 *   - Advisory locks are CLUSTER-global (not database-scoped), so we take it on the standalone's
 *     maintenance `postgres` database, which exists right after `ensureRevisium` — before the `dbos`
 *     database is even created. That lets the daemon decide "am I the owner?" BEFORE DBOS.launch() and
 *     before the queue worker starts polling.
 *   - The lock is held on a DEDICATED, long-lived connection for the daemon's whole life. It
 *     auto-releases when that connection ends — on graceful shutdown OR on a hard crash — so a dead
 *     owner never blocks a successor. (Verified by experiment before this code: a second connection's
 *     `pg_try_advisory_lock` returns false while held, and true again once the holder disconnects.)
 *
 * A daemon that does NOT win the lock lost a concurrent cold-start race (e.g. several `revo mcp`
 * bridges spawning at once) and exits; ensureHost then attaches to the winner via host.json. This
 * closes the "concurrent cold-start spawns multiple daemons" hole that let stale daemons accumulate.
 */
import pg from 'pg';

/** Minimal pg client surface used here (injectable for tests; mirrors ensure-postgres.ClientLike). */
export type OwnershipClient = {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
};

export type QueueOwnership = {
  /** True only for the single daemon that holds the lock. A false owner must not poll the queue. */
  owned: boolean;
  /** Release the lock + close the dedicated connection (no-op when not owned). */
  release: () => Promise<void>;
};

export type AcquireOwnershipDeps = {
  /** Connection factory (defaults to a real pg.Client). Tests inject a fake. */
  createClient?: (url: string) => OwnershipClient;
};

/** Stable advisory-lock identity for a profile's dev-tasks queue ownership. */
export function ownershipLockName(profile: string): string {
  return `revo:dev-tasks:${profile}`;
}

/**
 * Try to become the sole dev-tasks owner for `profile`. Returns `{owned:false}` (and closes its probe
 * connection) when another live daemon already holds it. When `{owned:true}`, the returned connection
 * stays open holding the lock until `release()` (or process death) frees it.
 */
export async function acquireQueueOwnership(
  profile: string,
  pgPort: number,
  deps: AcquireOwnershipDeps = {},
): Promise<QueueOwnership> {
  const url = `postgresql://revisium:password@localhost:${pgPort}/postgres`;
  const name = ownershipLockName(profile);
  const createClient = deps.createClient ?? ((u: string) => new pg.Client(u) as unknown as OwnershipClient);
  const client = createClient(url);
  await client.connect();

  const res = await client.query('SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS owned', [name]);
  const owned = res.rows[0]?.owned === true;

  if (!owned) {
    await client.end().catch(() => undefined);
    return { owned: false, release: async () => undefined };
  }

  // Keep `client` reachable (via this closure) so its socket — and the lock — is held for the daemon's
  // life. The OS frees the connection (and thus the lock) on crash; release() does it gracefully.
  const release = async (): Promise<void> => {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [name]);
    } catch {
      // best-effort; ending the connection releases the lock regardless
    }
    await client.end().catch(() => undefined);
  };
  return { owned: true, release };
}
