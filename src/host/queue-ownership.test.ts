import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireQueueOwnership, ownershipLockName, type OwnershipClient } from './queue-ownership.js';

// A fake pg client recording its lifecycle + queries, with a scripted pg_try_advisory_lock result.
function fakeClient(lockGranted: boolean) {
  const calls: { connected: number; ended: number; queries: Array<{ sql: string; params?: unknown[] }> } = {
    connected: 0,
    ended: 0,
    queries: [],
  };
  const client: OwnershipClient = {
    connect: async () => { calls.connected += 1; },
    query: async (sql: string, params?: unknown[]) => {
      calls.queries.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ owned: lockGranted }] };
      return { rows: [] };
    },
    end: async () => { calls.ended += 1; },
  };
  return { client, calls };
}

test('ownershipLockName: stable per-profile identity', () => {
  assert.equal(ownershipLockName('default'), 'revo:dev-tasks:default');
  assert.equal(ownershipLockName('dev'), 'revo:dev-tasks:dev');
});

test('acquireQueueOwnership: winner holds the lock; release unlocks + closes', async () => {
  const { client, calls } = fakeClient(true);
  const own = await acquireQueueOwnership('default', 15440, { createClient: () => client });

  assert.equal(own.owned, true, 'lock granted → owner');
  assert.equal(calls.connected, 1);
  assert.equal(calls.ended, 0, 'winner keeps the connection open to hold the lock');
  const tryLock = calls.queries.find((q) => q.sql.includes('pg_try_advisory_lock'));
  assert.ok(tryLock, 'tries the advisory lock');
  assert.deepEqual(tryLock?.params, ['revo:dev-tasks:default'], 'keyed on the profile lock name');

  await own.release();
  assert.ok(calls.queries.some((q) => q.sql.includes('pg_advisory_unlock')), 'release unlocks');
  assert.equal(calls.ended, 1, 'release closes the connection');
});

test('acquireQueueOwnership: loser is not owner and closes its probe connection immediately', async () => {
  const { client, calls } = fakeClient(false);
  const own = await acquireQueueOwnership('default', 15440, { createClient: () => client });

  assert.equal(own.owned, false, 'lock not granted → not owner (another daemon owns it)');
  assert.equal(calls.ended, 1, 'a loser must not leak its probe connection');
  await own.release(); // no-op, must not throw
  assert.equal(calls.ended, 1, 'release is a no-op for a loser');
});

test('acquireQueueOwnership: connects to the standalone maintenance db on the given port', async () => {
  let seenUrl = '';
  const { client } = fakeClient(true);
  await acquireQueueOwnership('dev', 15840, { createClient: (u) => { seenUrl = u; return client; } });
  assert.match(seenUrl, /:15840\/postgres$/, 'maintenance postgres db on the profile pg port');
});
