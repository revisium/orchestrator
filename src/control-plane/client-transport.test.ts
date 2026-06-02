import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from './errors.js';
import { extractMutationRow } from './client-transport.js';

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
