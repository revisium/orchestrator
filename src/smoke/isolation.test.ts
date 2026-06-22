import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSmokeIsolation, resolveSmokeIsolation } from './isolation.js';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function isolatedEnv(dataDir: string): Record<string, string> {
  return {
    REVO_DATA_DIR: dataDir,
    REVO_PORT: '29422',
    REVO_PG_PORT: '25640',
    REVO_DBOS_DB: 'dbos_smoke_isolation',
  };
}

test('smoke isolation rejects empty/default environment before state access', () => {
  withEnv({
    REVO_DATA_DIR: undefined,
    REVO_PORT: undefined,
    REVO_PG_PORT: undefined,
    REVO_DBOS_DB: undefined,
    REVO_GRAPHQL_PORT: undefined,
  }, () => {
    assert.throws(
      () => resolveSmokeIsolation({ scriptName: 'smoke:create-run' }),
      /REVO_DATA_DIR is required/,
    );
  });
});

test('smoke isolation rejects production defaults', () => {
  withEnv({
    REVO_DATA_DIR: '~/.revisium-orchestrator',
    REVO_PORT: '19222',
    REVO_PG_PORT: '15440',
    REVO_DBOS_DB: 'dbos',
  }, () => {
    assert.throws(
      () => resolveSmokeIsolation({ scriptName: 'smoke:control-plane' }),
      /default production data dir/,
    );
  });
});

test('smoke isolation accepts temp data dir, non-default ports, and isolated DBOS db', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'revo-smoke-isolation-'));
  try {
    withEnv(isolatedEnv(dataDir), () => {
      const isolation = assertSmokeIsolation({ scriptName: 'smoke:inspect-run' });
      assert.equal(isolation.dataDir, dataDir);
      assert.equal(isolation.httpPort, 29422);
      assert.equal(isolation.pgPort, 25640);
      assert.equal(isolation.dbosDb, 'dbos_smoke_isolation');
      assert.notEqual(isolation.dataDir, '~/.revisium-orchestrator');
      assert.notEqual(isolation.httpPort, 19222);
      assert.notEqual(isolation.pgPort, 15440);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('GraphQL smoke isolation requires explicit non-derived GraphQL port', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'revo-smoke-graphql-'));
  try {
    withEnv(isolatedEnv(dataDir), () => {
      assert.throws(
        () => resolveSmokeIsolation({ scriptName: 'smoke:graphql', requireGraphqlPort: true }),
        /REVO_GRAPHQL_PORT is required/,
      );

      process.env.REVO_GRAPHQL_PORT = '29423';
      assert.throws(
        () => resolveSmokeIsolation({ scriptName: 'smoke:graphql', requireGraphqlPort: true }),
        /implicit derived GraphQL port/,
      );

      process.env.REVO_GRAPHQL_PORT = '29424';
      const isolation = resolveSmokeIsolation({ scriptName: 'smoke:graphql', requireGraphqlPort: true });
      assert.equal(isolation.graphqlPort, 29424);
      assert.notEqual(isolation.graphqlPort, 19223);
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
