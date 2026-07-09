import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionFetchLimit, toConnection, toConnectionWithTotal } from './connection.js';

test('toConnection returns Relay-style page metadata', () => {
  const first = toConnection(['a', 'b', 'c'], { first: 2 });

  assert.deepEqual(first.edges.map((edge) => edge.node), ['a', 'b']);
  assert.equal(first.totalCount, 3);
  assert.equal(first.pageInfo.hasPreviousPage, false);
  assert.equal(first.pageInfo.hasNextPage, true);

  const second = toConnection(['a', 'b', 'c'], { first: 2, after: first.pageInfo.endCursor });
  assert.deepEqual(second.edges.map((edge) => edge.node), ['c']);
  assert.equal(second.pageInfo.hasPreviousPage, true);
  assert.equal(second.pageInfo.hasNextPage, false);
});

test('connectionFetchLimit fetches one extra row beyond the requested cursor window', () => {
  const first = toConnection(['a', 'b', 'c'], { first: 2 });

  assert.equal(connectionFetchLimit({ first: 2 }), 3);
  assert.equal(connectionFetchLimit({ first: 2, after: first.pageInfo.endCursor }), 5);
});

test('toConnectionWithTotal keeps storage totalCount while slicing fetched rows', () => {
  const connection = toConnectionWithTotal(['a', 'b'], 4, { first: 1 });

  assert.deepEqual(connection.edges.map((edge) => edge.node), ['a']);
  assert.equal(connection.totalCount, 4);
  assert.equal(connection.pageInfo.hasNextPage, true);
});
