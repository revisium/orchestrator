import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunResourceInputV1 } from './parse-run-resource-input.js';

const retention = { onSuccess: 'release', onFailure: 'retain', onCancel: 'release', onBlocked: 'retain' } as const;

test('accepts repository-free scratch input and rejects scratch contamination', () => {
  const result = parseRunResourceInputV1({ workspace: { isolation: 'scratch', retention }, bindings: {} });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.workspace.isolation, 'scratch');

  const contaminated = parseRunResourceInputV1({ resources: { source: { kind: 'repository', cardinality: 'one', required: true } }, workspace: { isolation: 'scratch', retention }, bindings: {} });
  assert.ok(contaminated.diagnostics.some((item) => item.code === 'SCRATCH_WITH_RESOURCES_INVALID'));
});

test('accepts exactly one required repository resource with a safe alias binding', () => {
  const result = parseRunResourceInputV1({
    resources: { source: { kind: 'repository', cardinality: 'one', required: true } },
    workspace: { isolation: 'resource', resource: 'source', mutability: 'mutable', identity: { template: 'revo/{taskId}' }, retention },
    bindings: { source: { repositoryId: 'repo_123', credentialAliases: { git: 'github-app' } } },
  });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.value?.bindings.source.repositoryId, 'repo_123');
});

test('rejects unsupported names, cardinality, bindings, and credential-shaped input', () => {
  const result = parseRunResourceInputV1({
    resources: {
      bad_name: { kind: 'repository', cardinality: 'many', required: true },
      other: { kind: 'repository', cardinality: 'one', required: true },
    },
    workspace: { isolation: 'resource', resource: 'bad_name', mutability: 'mutable', identity: { template: '/tmp/x' }, retention },
    bindings: { extra: { repositoryId: 'repo' }, bad_name: { repositoryId: 'Bearer token' } },
  });
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes('RESOURCE_NAME_INVALID'));
  assert.ok(codes.includes('RESOURCE_COUNT_UNSUPPORTED'));
  assert.ok(codes.includes('RESOURCE_BINDING_EXTRA'));
  assert.ok(codes.includes('RESOURCE_BINDING_MISSING'));
  assert.ok(codes.includes('RESOURCE_REF_UNRESOLVED'));
  assert.equal(result.value, null);
});
