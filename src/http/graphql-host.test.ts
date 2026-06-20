import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GRAPHQL_HOST,
  DEFAULT_GRAPHQL_PORT,
  resolveGraphqlHostOptions,
} from './graphql-host.js';

test('resolveGraphqlHostOptions defaults to local-only bind', () => {
  assert.deepEqual(resolveGraphqlHostOptions(), {
    host: DEFAULT_GRAPHQL_HOST,
    port: DEFAULT_GRAPHQL_PORT,
  });
});

test('resolveGraphqlHostOptions accepts explicit local port', () => {
  assert.deepEqual(resolveGraphqlHostOptions({ port: 19423 }), {
    host: DEFAULT_GRAPHQL_HOST,
    port: 19423,
  });
});

test('resolveGraphqlHostOptions reads environment overrides', () => {
  const oldHost = process.env.REVO_GRAPHQL_HOST;
  const oldPort = process.env.REVO_GRAPHQL_PORT;
  process.env.REVO_GRAPHQL_HOST = '127.0.0.1';
  process.env.REVO_GRAPHQL_PORT = '19424';
  try {
    assert.deepEqual(resolveGraphqlHostOptions(), {
      host: DEFAULT_GRAPHQL_HOST,
      port: 19424,
    });
  } finally {
    if (oldHost === undefined) {
      delete process.env.REVO_GRAPHQL_HOST;
    } else {
      process.env.REVO_GRAPHQL_HOST = oldHost;
    }
    if (oldPort === undefined) {
      delete process.env.REVO_GRAPHQL_PORT;
    } else {
      process.env.REVO_GRAPHQL_PORT = oldPort;
    }
  }
});

test('resolveGraphqlHostOptions rejects invalid environment ports', () => {
  const oldPort = process.env.REVO_GRAPHQL_PORT;
  process.env.REVO_GRAPHQL_PORT = 'not-a-port';
  try {
    assert.throws(() => resolveGraphqlHostOptions(), /Invalid GraphQL port/);
  } finally {
    if (oldPort === undefined) {
      delete process.env.REVO_GRAPHQL_PORT;
    } else {
      process.env.REVO_GRAPHQL_PORT = oldPort;
    }
  }
});
