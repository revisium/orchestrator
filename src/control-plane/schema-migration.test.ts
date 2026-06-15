import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAdditiveSchemaPatches } from './schema-migration.js';

test('computeAdditiveSchemaPatches: adds missing properties and replaces changed property definitions', () => {
  const current = {
    type: 'object',
    properties: {
      output_summary: { type: 'string', default: '' },
      stale: { type: 'string', default: '' },
    },
  };
  const desired = {
    type: 'object',
    properties: {
      output_summary: { type: 'string', default: '', description: 'Serialized JSON' },
      artifact_ref: { type: 'string', default: '' },
      'slash/name': { type: 'number', default: 0 },
    },
  };

  assert.deepEqual(computeAdditiveSchemaPatches(current, desired), [
    {
      op: 'replace',
      path: '/properties/output_summary',
      value: { type: 'string', default: '', description: 'Serialized JSON' },
    },
    {
      op: 'add',
      path: '/properties/artifact_ref',
      value: { type: 'string', default: '' },
    },
    {
      op: 'add',
      path: '/properties/slash~1name',
      value: { type: 'number', default: 0 },
    },
  ]);
});

test('computeAdditiveSchemaPatches: returns no patches when desired properties already match', () => {
  const schema = {
    type: 'object',
    properties: {
      artifact_ref: { default: '', type: 'string' },
    },
  };

  assert.deepEqual(computeAdditiveSchemaPatches(schema, schema), []);
});
