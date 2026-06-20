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
