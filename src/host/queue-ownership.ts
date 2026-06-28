

























import pg from 'pg';




const LOCK_KEY_EXPR = `('x' || substr(md5($1), 1, 16))::bit(64)::bigint`;


export type OwnershipClient = {
  connect(): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
};

export type QueueOwnership = {

  owned: boolean;

  release: () => Promise<void>;
};

export type AcquireOwnershipDeps = {

  createClient?: (url: string) => OwnershipClient;
};


export function ownershipLockName(profile: string): string {
  return `revo:dev-tasks:${profile}`;
}




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

  const release = async (): Promise<void> => {
    try {
      await client.query(`SELECT pg_advisory_unlock(${LOCK_KEY_EXPR})`, [name]);
    } catch {
    }
    await client.end().catch(() => undefined);
  };
  return { owned: true, release };
}
