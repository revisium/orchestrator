import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPreview } from './runner-common.js';

test('runner common: boundedPreview handles undefined root values', () => {
  assert.equal(boundedPreview(undefined), 'undefined');
});

test('runner common: boundedPreview still returns bounded JSON for normal values', () => {
  const preview = boundedPreview({ text: 'x'.repeat(2_000) });

  assert.ok(preview.length <= 1_003);
  assert.match(preview, /\.\.\./);
});
