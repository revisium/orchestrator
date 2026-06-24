/**
 * Daemon singleton gate (slice 139, hardened slice 140). Exactly ONE host daemon per profile may own —
 * and therefore poll — the `dev-tasks` WorkflowQueue. Ownership is a connection-scoped Postgres
 * ADVISORY LOCK:
 *
 *   - Advisory locks are DATABASE-scoped, NOT cluster-global (PG: "Advisory locks are local to each
 *     database"). The gate works only because every contending daemon connects to the SAME fixed
 *     maintenance `postgres` database, so they all contend in one shared per-database lock namespace.
 *     We use `postgres` because it exists right after `ensureRevisium` — before the per-profile `dbos`
 *     database is created — letting the daemon decide "am I the owner?" BEFORE DBOS.launch() and before
 *     the queue worker starts polling. INVARIANT: all contenders MUST take this lock on the identical
 *     database. NEVER probe this lock key from another database (e.g. `dbos`) expecting a conflict — it
 *     would silently NOT conflict and could mint a second owner.
 *   - The key is a FULL 64-bit value derived from the lock name via md5 (`('x'||substr(md5(name),1,16))
 *     ::bit(64)::bigint`), not `hashtext(...)::bigint` — `hashtext` is only 32 bits, so distinct
 *     profile names could hash-collide and wrongly block a different profile's daemon. md5's 64 bits
 *     make a cross-profile collision negligible.
 *   - The lock is held on a DEDICATED, long-lived connection for the daemon's whole life. It
 *     auto-releases when that connection ends — on graceful shutdown OR on a hard crash — so a dead
 *     owner never blocks a successor. (Verified by experiment: a second connection's
 *     `pg_try_advisory_lock` returns false while held, and true again once the holder disconnects.)
 *
 * A daemon that does NOT win the lock lost a concurrent cold-start race (e.g. several `revo mcp`
 * bridges spawning at once) and exits; ensureHost then attaches to the winner via host.json. This
 * closes the "concurrent cold-start spawns multiple daemons" hole that let stale daemons accumulate.
 * It does NOT, however, coordinate LEGACY hosts that predate the lock — those are detected by the
 * `pg_stat_activity` census (queue-poller-census.ts) and evicted by `revo doctor`/`stop` (slice 140).
 */
import pg from 'pg';

/**
 * SQL expression that turns the text lock name (bound as `$1`) into a full 64-bit advisory-lock key.
 * `md5` yields 128 bits of hex; the first 16 hex chars are reinterpreted as a signed bigint. Shared by
 * lock + unlock so they always target the identical key.
 */
const LOCK_KEY_EXPR = `('x' || substr(md5($1), 1, 16))::bit(64)::bigint`;

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

  const res = await client.query(`SELECT pg_try_advisory_lock(${LOCK_KEY_EXPR}) AS owned`, [name]);
  const owned = res.rows[0]?.owned === true;

  if (!owned) {
    await client.end().catch(() => undefined);
    return { owned: false, release: async () => undefined };
  }

  // Keep `client` reachable (via this closure) so its socket — and the lock — is held for the daemon's
  // life. The OS frees the connection (and thus the lock) on crash; release() does it gracefully.
  const release = async (): Promise<void> => {
    try {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_EXPR})`, [name]);
    } catch {
      // best-effort; ending the connection releases the lock regardless
    }
    await client.end().catch(() => undefined);
  };
  return { owned: true, release };
}
