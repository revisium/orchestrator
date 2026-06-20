import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortOption } from './serve.js';

test('parsePortOption returns undefined when unset', () => {
  assert.equal(parsePortOption(undefined), undefined);
});

test('parsePortOption parses a valid TCP port', () => {
  assert.equal(parsePortOption('19231'), 19231);
});

test('parsePortOption rejects invalid ports', () => {
  assert.throws(() => parsePortOption('0'), /Invalid --port value/);
  assert.throws(() => parsePortOption('65536'), /Invalid --port value/);
  assert.throws(() => parsePortOption('abc'), /Invalid --port value/);
});
