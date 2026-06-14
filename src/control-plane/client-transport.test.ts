import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import { extractMutationRow, mapTransportListEdges } from './client-transport.js';

test('mapTransportListEdges skips SDK edges without node data', () => {
  const edges = mapTransportListEdges([
    { cursor: 'missing' },
    { cursor: 'row-1', node: { id: 'row-1', data: { id: 'row-1' } } },
  ]);

  assert.equal(edges?.length, 1);
  assert.equal(edges?.[0]?.cursor, 'row-1');
  assert.deepEqual(edges?.[0]?.node?.data, { id: 'row-1' });
});

test('updateRow throws HTTP_ERROR when SDK success response has no row', () => {
  assert.throws(
    () => extractMutationRow({ data: {} }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'HTTP_ERROR',
  );
});

test('patchRow throws HTTP_ERROR when SDK success response has no row', () => {
  assert.throws(
    () => extractMutationRow({ data: { row: undefined } }),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'HTTP_ERROR',
  );
});
