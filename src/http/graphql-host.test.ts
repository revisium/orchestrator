import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  DEFAULT_GRAPHQL_HOST,
  startGraphqlHost,
  resolveGraphqlHostOptions,
} from './graphql-host.js';
import { resolveDefaultGraphqlPort } from '../config.js';

test('resolveGraphqlHostOptions defaults to local-only bind', () => {
  assert.deepEqual(resolveGraphqlHostOptions(), {
    host: DEFAULT_GRAPHQL_HOST,
    port: resolveDefaultGraphqlPort(),
  });
});

test('resolveGraphqlHostOptions accepts explicit local port', () => {
  assert.deepEqual(resolveGraphqlHostOptions({ port: 19423 }), {
    host: DEFAULT_GRAPHQL_HOST,
    port: 19423,
  });
});

test('resolveGraphqlHostOptions accepts only loopback host in v1', () => {
  const oldHost = process.env.REVO_GRAPHQL_HOST;
  const oldPort = process.env.REVO_GRAPHQL_PORT;
  process.env.REVO_GRAPHQL_HOST = DEFAULT_GRAPHQL_HOST;
  process.env.REVO_GRAPHQL_PORT = '19424';
  try {
    assert.deepEqual(resolveGraphqlHostOptions(), {
      host: DEFAULT_GRAPHQL_HOST,
      port: 19424,
    });
    process.env.REVO_GRAPHQL_HOST = '0.0.0.0';
    assert.throws(() => resolveGraphqlHostOptions(), /GraphQL host must bind 127\.0\.0\.1/);
    assert.throws(() => resolveGraphqlHostOptions({ host: '::1' }), /GraphQL host must bind 127\.0\.0\.1/);
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
    process.env.REVO_GRAPHQL_PORT = '19424abc';
    assert.throws(() => resolveGraphqlHostOptions(), /Invalid GraphQL port/);
  } finally {
    if (oldPort === undefined) {
      delete process.env.REVO_GRAPHQL_PORT;
    } else {
      process.env.REVO_GRAPHQL_PORT = oldPort;
    }
  }
});

test('startGraphqlHost fails actionably when the resolved port is occupied', async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, DEFAULT_GRAPHQL_HOST, () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(
      () => startGraphqlHost({ port: address.port }),
      /GraphQL port \d+ is already in use; set REVO_GRAPHQL_PORT or --port to a free isolated port/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
