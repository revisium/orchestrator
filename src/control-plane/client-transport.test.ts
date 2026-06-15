import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import { extractMutationRow, makeRecoverableScopeResolver, mapTransportListEdges } from './client-transport.js';

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

test('makeRecoverableScopeResolver clears rejected bootstrap scope so retry can recover', async () => {
  let calls = 0;
  const resolveScope = makeRecoverableScopeResolver(async () => {
    calls++;
    if (calls === 1) {
      throw new ControlPlaneError('BOOTSTRAP_NOT_APPLIED', 'bootstrap missing');
    }
    return { revisionId: 'rev-1' };
  });

  await assert.rejects(
    () => resolveScope.resolve(),
    (error: unknown) => error instanceof ControlPlaneError && error.code === 'BOOTSTRAP_NOT_APPLIED',
  );

  await assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });
  assert.equal(calls, 2);
});

test('makeRecoverableScopeResolver invalidate drops the cached revision scope', async () => {
  let calls = 0;
  const resolveScope = makeRecoverableScopeResolver(async () => ({ revisionId: `rev-${++calls}` }));

  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });
  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });

  resolveScope.invalidate();

  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-2' });
  assert.equal(calls, 2);
});
