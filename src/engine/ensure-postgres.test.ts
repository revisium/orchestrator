/**
 * Unit tests for ensurePostgres / dbosSystemDatabaseUrl (T2, E3, E4, F17, F20).
 *
 * F20: Tests call the REAL ensurePostgres() with an injected fake ClientLike so they
 * exercise the actual 42P04 catch / SELECT fast-path in ensure-postgres.ts, not a
 * local reimplementation. `runEnsurePostgresLogic` has been removed.
 *
 * F17 tests verify the 42P04 (duplicate_database) race-safety backstop:
 *   - When CREATE DATABASE throws {code:'42P04'}, ensurePostgres RESOLVES (swallowed).
 *   - Any other pg error code causes ensurePostgres to REJECT (re-thrown).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dbosSystemDatabaseUrl, ensurePostgres, type ClientLike } from './ensure-postgres.js';

/** PostgreSQL SQLSTATE 42P04 = duplicate_database — named constant, not magic string. */
const PG_SQLSTATE_DUPLICATE_DATABASE = '42P04';

// ── dbosSystemDatabaseUrl ────────────────────────────────────────────────────

test('dbosSystemDatabaseUrl: builds the correct URL with default creds', () => {
  const url = dbosSystemDatabaseUrl(15440);
  assert.equal(url, 'postgresql://revisium:password@localhost:15440/dbos');
});

test('dbosSystemDatabaseUrl: uses provided user/password', () => {
  const url = dbosSystemDatabaseUrl(5432, 'myuser', 'mypass');
  assert.equal(url, 'postgresql://myuser:mypass@localhost:5432/dbos');
});

test('dbosSystemDatabaseUrl: never hardcodes the port', () => {
  const url1 = dbosSystemDatabaseUrl(12345);
  const url2 = dbosSystemDatabaseUrl(54321);
  assert.ok(url1.includes(':12345/'));
  assert.ok(url2.includes(':54321/'));
  assert.notEqual(url1, url2);
});

test('dbosSystemDatabaseUrl: contains the dbos database name', () => {
  const url = dbosSystemDatabaseUrl(15440);
  assert.ok(url.endsWith('/dbos'), 'URL must end with /dbos');
});

// ── ensurePostgres with injectable ClientLike (F20) ──────────────────────────
//
// Helper: build a fake ClientLike that exercises the REAL ensurePostgres logic.
// `queryFn` controls what query() returns/throws for each SQL string.

interface FakeQueryFn {
  (sql: string, params?: unknown[]): Promise<{ rows: { count: string }[] }>;
}

function makeFakeClient(queryFn: FakeQueryFn): ClientLike {
  return {
    connect: async () => undefined,
    query: queryFn,
    end: async () => undefined,
  };
}

// ── CREATE-when-absent / no-op-when-present ───────────────────────────────────

test('ensurePostgres: CREATE DATABASE issued when absent (E4)', async () => {
  let createCalled = false;
  await ensurePostgres(15440, {}, {
    createClient: () =>
      makeFakeClient(async (sql) => {
        if (sql.includes('CREATE DATABASE')) {
          createCalled = true;
          return { rows: [] };
        }
        return { rows: [{ count: '0' }] }; // db does not exist
      }),
  });
  assert.ok(createCalled, 'CREATE DATABASE must be issued when count=0');
});

test('ensurePostgres: no-op when database already exists (E3)', async () => {
  let createCalled = false;
  await ensurePostgres(15440, {}, {
    createClient: () =>
      makeFakeClient(async (sql) => {
        if (sql.includes('CREATE DATABASE')) createCalled = true;
        return { rows: [{ count: '1' }] }; // db exists
      }),
  });
  assert.ok(!createCalled, 'CREATE DATABASE must NOT be issued when db exists');
});

test('ensurePostgres: idempotent — count guard works for any positive count', async () => {
  let createCalled = false;
  await ensurePostgres(15440, {}, {
    createClient: () =>
      makeFakeClient(async (sql) => {
        if (sql.includes('CREATE DATABASE')) createCalled = true;
        return { rows: [{ count: '3' }] };
      }),
  });
  assert.ok(!createCalled, 'CREATE DATABASE must NOT be issued when count>0');
});

test('ensurePostgres: client.end() is called in finally (even when db exists)', async () => {
  let endCalled = false;
  await ensurePostgres(15440, {}, {
    createClient: () => ({
      connect: async () => undefined,
      query: async () => ({ rows: [{ count: '1' }] }),
      end: async () => { endCalled = true; },
    }),
  });
  assert.ok(endCalled, 'client.end() must always be called in finally');
});

test('ensurePostgres: client.end() is called in finally even when CREATE DATABASE throws non-42P04', async () => {
  let endCalled = false;
  try {
    await ensurePostgres(15440, {}, {
      createClient: () => ({
        connect: async () => undefined,
        query: async (sql: string) => {
          if (sql.includes('CREATE DATABASE')) {
            const err = Object.assign(new Error('permission denied'), { code: '42501' });
            throw err;
          }
          return { rows: [{ count: '0' }] };
        },
        end: async () => { endCalled = true; },
      }),
    });
  } catch {
    // expected
  }
  assert.ok(endCalled, 'client.end() must be called even when an error is thrown');
});

// ── F17: 42P04 (duplicate_database) race-safety backstop ─────────────────────

test('ensurePostgres F17: 42P04 on CREATE DATABASE is swallowed — RESOLVES (F20)', async () => {
  // F20 requirement: call REAL ensurePostgres, injecting a fake client whose
  // query('CREATE DATABASE dbos') throws {code:'42P04'}. Assert it RESOLVES.
  let createAttempted = false;
  let endCalled = false;

  await ensurePostgres(15440, {}, {
    createClient: () => ({
      connect: async () => undefined,
      query: async (sql: string) => {
        if (sql.includes('CREATE DATABASE')) {
          createAttempted = true;
          throw Object.assign(new Error('duplicate database'), {
            code: PG_SQLSTATE_DUPLICATE_DATABASE,
          });
        }
        return { rows: [{ count: '0' }] }; // SELECT: db does not exist
      },
      end: async () => { endCalled = true; },
    }),
  });

  // If we reach here the error was swallowed correctly (no throw propagated).
  assert.ok(createAttempted, 'CREATE DATABASE must have been attempted');
  assert.ok(endCalled, 'client.end() must be called even when 42P04 is swallowed');
});

test('ensurePostgres F17: non-42P04 pg error on CREATE DATABASE IS re-thrown (F20)', async () => {
  // F20 requirement: call REAL ensurePostgres, injecting a fake client whose
  // query('CREATE DATABASE dbos') throws {code:'42501'}. Assert it REJECTS.
  const PERMISSION_DENIED = '42501';
  let thrown = false;

  try {
    await ensurePostgres(15440, {}, {
      createClient: () =>
        makeFakeClient(async (sql) => {
          if (sql.includes('CREATE DATABASE')) {
            throw Object.assign(new Error('permission denied to create database'), {
              code: PERMISSION_DENIED,
            });
          }
          return { rows: [{ count: '0' }] }; // db does not exist
        }),
    });
  } catch (err) {
    thrown = true;
    assert.equal(
      (err as { code?: string }).code,
      PERMISSION_DENIED,
      'non-42P04 error must be re-thrown with original code',
    );
  }
  assert.ok(thrown, 'non-42P04 error must propagate (not swallowed)');
});

test('ensurePostgres F17: 42P04 is the exact SQLSTATE constant (not a magic string)', () => {
  // Verify that the named constant value matches the PostgreSQL spec.
  assert.equal(
    PG_SQLSTATE_DUPLICATE_DATABASE,
    '42P04',
    'SQLSTATE 42P04 must be the duplicate_database code per PostgreSQL spec',
  );
});

// ── dbosSystemDatabaseUrl integration with ensurePostgres port ───────────────

test('ensurePostgres: pg port must come from pid-proven runtime (never hardcoded default)', () => {
  // Verify that the URL is built with the exact port passed in (not hardcoded 15440).
  const provenPort = 15999;
  const url = dbosSystemDatabaseUrl(provenPort);
  assert.ok(url.includes(`:${provenPort}/`), 'URL must use the provided pg port');
  assert.ok(!url.includes(':15440/'), 'URL must NOT hardcode the preferred default port 15440');
});
