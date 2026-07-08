import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneError } from './errors.js';
import { validateBootstrapJsonFields } from './bootstrap-json-validator.js';

type SeedConfig = {
  rows?: Array<{ tableId: string; rowId: string; data: Record<string, unknown> }>;
};

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..');
const seedPath = resolve(repoRoot, 'control-plane', 'bootstrap.config.json');

test('validateBootstrapJsonFields: bundled seed serialized JSON fields pass schema validation', () => {
  const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedConfig;
  assert.doesNotThrow(() => validateBootstrapJsonFields(seed.rows ?? []));
});

test('validateBootstrapJsonFields: rejects malformed role scope_rules JSON', () => {
  assert.throws(
    () =>
      validateBootstrapJsonFields([
        { tableId: 'roles', rowId: 'developer', data: { scope_rules: '{not json' } },
      ]),
    (error: unknown) =>
      error instanceof ControlPlaneError &&
      error.code === 'VALIDATION_FAILURE' &&
      /roles\/developer\.scope_rules must be valid serialized JSON/.test(error.message),
  );
});

test('validateBootstrapJsonFields: rejects non-object model profile params', () => {
  assert.throws(
    () =>
      validateBootstrapJsonFields([
        { tableId: 'model_profiles', rowId: 'standard', data: { params: '[]' } },
      ]),
    /model_profiles\/standard\.params violates model profile params schema: \/ must be object/,
  );
});

test('validateBootstrapJsonFields: rejects unknown model profile params keys', () => {
  assert.throws(
    () =>
      validateBootstrapJsonFields([
        { tableId: 'model_profiles', rowId: 'standard', data: { params: '{"maxTuns":10}' } },
      ]),
    /model_profiles\/standard\.params violates model profile params schema: .*maxTuns/,
  );
});

test('validateBootstrapJsonFields: rejects invalid routing policy rule shape', () => {
  assert.throws(
    () =>
      validateBootstrapJsonFields([
        {
          tableId: 'routing_policy',
          rowId: 'pipeline',
          data: { rule: '{"max_attempts":0,"budget_tokens":-1}' },
        },
      ]),
    /routing_policy\/pipeline\.rule violates routing policy rule schema: .*max_attempts.*budget_tokens/,
  );
});
