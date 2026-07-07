import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbosDbName } from '../engine/ensure-postgres.js';
import {
  assertDistinctDatabaseNames,
  assertSqlIdentifier,
  resolveRevoDbName,
} from './revo-database.js';

function withEnv<T>(patch: NodeJS.ProcessEnv, run: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const key of Object.keys(patch)) old[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('assertSqlIdentifier rejects invalid, reserved, and overlong database names', () => {
  assert.throws(() => assertSqlIdentifier('bad-name', 'REVO_DB'), /SQL identifier/);
  assert.throws(() => assertSqlIdentifier('postgres', 'REVO_DB'), /reserved PostgreSQL database name/);
  assert.throws(() => assertSqlIdentifier(`r${'x'.repeat(63)}`, 'REVO_DB'), /<= 63 bytes/);
});

test('resolveRevoDbName and resolveDbosDbName use profile defaults and env overrides', () => {
  withEnv({ REVO_PROFILE: 'dev', REVO_DB: undefined, REVO_DBOS_DB: undefined }, () => {
    assert.equal(resolveRevoDbName(), 'revo_dev');
    assert.equal(resolveDbosDbName(), 'dbos_dev');
  });
  withEnv({ REVO_DB: 'revo_custom', REVO_DBOS_DB: 'dbos_custom' }, () => {
    assert.equal(resolveRevoDbName(), 'revo_custom');
    assert.equal(resolveDbosDbName(), 'dbos_custom');
  });
});

test('database names for Revo and DBOS must be distinct', () => {
  assert.doesNotThrow(() => assertDistinctDatabaseNames('revo', 'dbos'));
  assert.throws(() => assertDistinctDatabaseNames('same_db', 'same_db'), /must differ/);
});
