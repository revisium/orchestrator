import assert from 'node:assert/strict';
import test from 'node:test';
import { graphqlSubscriptionResult } from './graphql-context.js';

test('GraphQL WebSocket buffering retains null data with protocol errors', () => {
  const result = graphqlSubscriptionResult<null>({
    data: null,
    errors: [{ message: 'resolver failed', path: ['runEventAppended'] }],
  });

  assert.equal(Object.hasOwn(result, 'data'), true);
  assert.equal(result.data, null);
  assert.deepEqual(result.errors, [{ message: 'resolver failed', path: ['runEventAppended'] }]);
});

test('GraphQL WebSocket buffering retains partial data with protocol errors', () => {
  const result = graphqlSubscriptionResult<{ runEventAppended: null; status: { running: boolean } }>({
    data: { runEventAppended: null, status: { running: true } },
    errors: [{ message: 'event unavailable', path: ['runEventAppended'] }],
  });

  assert.deepEqual(result.data, { runEventAppended: null, status: { running: true } });
  assert.deepEqual(result.errors, [{ message: 'event unavailable', path: ['runEventAppended'] }]);
});
