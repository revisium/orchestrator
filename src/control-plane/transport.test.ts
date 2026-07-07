import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import { makeRecoverableScopeResolver } from './transport.js';

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
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'BOOTSTRAP_NOT_APPLIED',
  );

  await assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });
  assert.equal(calls, 2);
});

test('makeRecoverableScopeResolver invalidate drops the cached revision scope', async () => {
  let calls = 0;
  const resolveScope = makeRecoverableScopeResolver(async () => ({
    revisionId: `rev-${++calls}`,
  }));

  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });
  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-1' });

  resolveScope.invalidate();

  assert.deepEqual(await resolveScope.resolve(), { revisionId: 'rev-2' });
  assert.equal(calls, 2);
});
