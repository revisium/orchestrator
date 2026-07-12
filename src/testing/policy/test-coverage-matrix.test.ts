import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameExactStringSet } from './exact-string-set.js';
import { validateTestCoverageMatrix } from './test-coverage-matrix.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const matrixPath = resolve(repositoryRoot, 'docs/specs/test-coverage-matrix-v1.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as Record<string, unknown>;

function cloneMatrix(): Record<string, unknown> {
  return structuredClone(matrix);
}

test('test coverage matrix has complete shape and repository-relative live evidence paths', () => {
  assert.deepEqual(validateTestCoverageMatrix(matrix, repositoryRoot), []);
});

test('test coverage matrix rejects malformed rows', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  delete rows[0]?.['owner'];
  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('.owner is required')));
});

test('test coverage matrix rejects absolute and missing evidence paths', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  rows[0]!['evidencePaths'] = ['/tmp/not-repository-relative', 'src/missing-stage-2-evidence.ts'];
  const diagnostics = validateTestCoverageMatrix(fixture, repositoryRoot);
  assert.equal(diagnostics.filter((diagnostic) => diagnostic.code === 'MATRIX_EVIDENCE_PATH').length, 2);
});

test('test coverage matrix rejects unsupported Stage 3 implementation claims', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const observed = rows.find((row) => row['id'] === 'observed-runtime-coverage');
  assert.ok(observed);
  observed['currentStatus'] = 'strong';
  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_FUTURE_CLAIM'));
});

test('test coverage matrix rejects stale owner paths that contradict the canonical layer', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const declared = rows.find((row) => row['id'] === 'pipeline-declared-coverage');
  assert.ok(declared);
  declared['owner'] = ['src/control-plane'];

  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' &&
    diagnostic.message.includes('pipeline-declared-coverage') &&
    diagnostic.message.includes('canonical static-policy owner')));
});

test('test coverage matrix rejects a canonical family relabelled with plausible unit ownership', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const declared = rows.find((row) => row['id'] === 'pipeline-declared-coverage');
  assert.ok(declared);
  declared['owningLayer'] = 'unit';
  declared['owner'] = ['src/pipeline-core'];
  declared['evidencePaths'] = ['src/pipeline-core/interpret.test.ts'];

  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' &&
    diagnostic.message.includes('pipeline-declared-coverage') &&
    diagnostic.message.includes('canonical owning layer')));
});

test('test coverage matrix rejects swapped canonical family ownership', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const pipelineCore = rows.find((row) => row['id'] === 'pipeline-core');
  const declared = rows.find((row) => row['id'] === 'pipeline-declared-coverage');
  assert.ok(pipelineCore);
  assert.ok(declared);
  const pipelineCoreOwnership = {
    owningLayer: pipelineCore['owningLayer'],
    owner: pipelineCore['owner'],
    evidencePaths: pipelineCore['evidencePaths'],
  };
  pipelineCore['owningLayer'] = declared['owningLayer'];
  pipelineCore['owner'] = declared['owner'];
  pipelineCore['evidencePaths'] = declared['evidencePaths'];
  declared['owningLayer'] = pipelineCoreOwnership.owningLayer;
  declared['owner'] = pipelineCoreOwnership.owner;
  declared['evidencePaths'] = pipelineCoreOwnership.evidencePaths;

  const diagnostics = validateTestCoverageMatrix(fixture, repositoryRoot);
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('pipeline-core')));
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('pipeline-declared-coverage')));
});

test('test coverage matrix rejects an extra existing but stale owner path', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const declared = rows.find((row) => row['id'] === 'pipeline-declared-coverage');
  assert.ok(declared);
  declared['owner'] = [...declared['owner'] as string[], 'src/control-plane'];

  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' &&
    diagnostic.message.includes('pipeline-declared-coverage') &&
    diagnostic.message.includes('stale canonical owner')));
});

test('test coverage matrix compares canonical owners as a total string set', () => {
  const reorderedFixture = cloneMatrix();
  const reorderedRows = reorderedFixture['contractFamilies'] as Array<Record<string, unknown>>;
  const reordered = reorderedRows.find((row) => row['id'] === 'profiles-materialization');
  assert.ok(reordered);
  reordered['owner'] = [...reordered['owner'] as string[]].reverse();
  assert.deepEqual(validateTestCoverageMatrix(reorderedFixture, repositoryRoot), []);

  const duplicateFixture = cloneMatrix();
  const duplicateRows = duplicateFixture['contractFamilies'] as Array<Record<string, unknown>>;
  const duplicated = duplicateRows.find((row) => row['id'] === 'profiles-materialization');
  assert.ok(duplicated);
  duplicated['owner'] = ['src/pipeline-core', 'src/pipeline-core'];
  assert.ok(validateTestCoverageMatrix(duplicateFixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' &&
    diagnostic.message.includes('profiles-materialization') &&
    diagnostic.message.includes('stale canonical owner')));
});

test('test coverage matrix compares Unicode-equivalent strings as exact set members', () => {
  const composed = 'é';
  const decomposed = 'e\u0301';

  assert.equal(composed.localeCompare(decomposed), 0);
  assert.equal(sameExactStringSet([composed, decomposed], [decomposed, composed]), true);
});

test('test coverage matrix stops before snapshot validation when contract families are invalid', () => {
  const fixture = cloneMatrix();
  fixture['contractFamilies'] = [];
  fixture['snapshotNotice'] = 'invalid notice';

  assert.deepEqual(validateTestCoverageMatrix(fixture, repositoryRoot), [
    { code: 'MATRIX_SHAPE', message: 'matrix.contractFamilies must be a non-empty array' },
  ]);
});

test('test coverage matrix skips sparse layer holes', () => {
  const fixture = cloneMatrix();
  const layers = fixture['layers'] as Array<Record<string, unknown>>;
  layers.length += 1;

  assert.deepEqual(validateTestCoverageMatrix(fixture, repositoryRoot), []);
});

test('test coverage matrix preserves performance baseline diagnostic order', () => {
  const fixture = cloneMatrix();
  const performance = fixture['performanceBaseline'] as Record<string, unknown>;
  performance['captureMethod'] = null;
  performance['sampleCount'] = 0;
  performance['samples'] = [{}];
  performance['e2eJobSeconds'] = null;
  performance['combinedSetupPlusTestActionStepSeconds'] = null;
  performance['localWallClockTargetSeconds'] = null;
  performance['ciFileConcurrency'] = 0;
  performance['localDefaultFileConcurrency'] = 0;

  assert.deepEqual(validateTestCoverageMatrix(fixture, repositoryRoot), [
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.captureMethod must be an object' },
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.sampleCount must be a positive integer' },
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.samples must match sampleCount' },
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.e2eJobSeconds must be an object' },
    {
      code: 'MATRIX_SHAPE',
      message: 'matrix.performanceBaseline.combinedSetupPlusTestActionStepSeconds must be an object',
    },
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.localWallClockTargetSeconds must be an object' },
    { code: 'MATRIX_SHAPE', message: 'matrix.performanceBaseline.ciFileConcurrency must be a positive integer' },
    {
      code: 'MATRIX_SHAPE',
      message: 'matrix.performanceBaseline.localDefaultFileConcurrency must be a positive integer',
    },
  ]);
});

test('test coverage matrix rejects missing or unknown canonical contract families', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  rows.splice(rows.findIndex((row) => row['id'] === 'graphql-surface'), 1);
  rows.push({
    ...structuredClone(rows[0]),
    id: 'invented-stage-3-runtime-trace',
  });

  const diagnostics = validateTestCoverageMatrix(fixture, repositoryRoot);
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('missing canonical family graphql-surface')));
  assert.ok(diagnostics.some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('unknown contract family invented-stage-3-runtime-trace')));
});

test('test coverage matrix rejects a Stage 3 target that no longer records its unimplemented gap', () => {
  const fixture = cloneMatrix();
  const rows = fixture['contractFamilies'] as Array<Record<string, unknown>>;
  const runtimeRecovery = rows.find((row) => row['id'] === 'runtime-recovery');
  assert.ok(runtimeRecovery);
  runtimeRecovery['currentStatus'] = 'strong';
  runtimeRecovery['gaps'] = [];

  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_FUTURE_CLAIM' &&
    diagnostic.message.includes('runtime-recovery')));
});

const expectedExemplars = [
  ['unit', 'src/pipeline-core/interpret.test.ts'],
  ['static-policy', 'src/testing/policy/pipeline-coverage.test.ts'],
  ['pipeline-dsl', 'src/e2e/pipeline/recovery-graph.e2e.test.ts'],
  ['integration', 'src/e2e/integration/run-lifecycle.e2e.test.ts'],
  ['mcp', 'src/e2e/surfaces/mcp/stdio.e2e.test.ts'],
  ['graphql', 'src/e2e/surfaces/graphql/graphql.e2e.test.ts'],
  ['cli', 'src/e2e/surfaces/cli/lifecycle.e2e.test.ts'],
  ['runtime', 'src/e2e/runtime/recovery/recovery.e2e.test.ts'],
] as const;

test('test coverage matrix has exactly one correctly classified executable exemplar per layer', () => {
  const exemplars = matrix['executableExemplars'] as Array<Record<string, unknown>>;
  assert.deepEqual(exemplars.map((item) => [item['layer'], item['path']]), expectedExemplars);
  assert.deepEqual(validateTestCoverageMatrix(matrix, repositoryRoot), []);
});

test('test coverage matrix rejects malformed executable exemplar paths and layers', () => {
  const validEntries: Array<Record<string, string>> = expectedExemplars.map(([layer, path]) => ({ layer, path }));
  const cases = [
    ['missing', undefined, /executableExemplars must be/],
    ['duplicate', [...validEntries, validEntries[0]], /must contain exactly one exemplar/],
    ['unknown layer', validEntries.with(0, { layer: 'unknown', path: expectedExemplars[0][1] }), /unknown exemplar layer/],
    ['absolute', validEntries.with(0, { layer: 'unit', path: '/tmp/example.test.ts' }), /must be repository-relative/],
    ['escaping', validEntries.with(0, { layer: 'unit', path: 'src/../outside.test.ts' }), /must not escape repository root/],
    ['missing path', validEntries.with(0, { layer: 'unit', path: 'src/missing.test.ts' }), /references missing path/],
    ['wrong layer', validEntries.with(0, { layer: 'static-policy', path: expectedExemplars[0][1] }), /does not belong to exemplar layer/],
  ] as const;

  for (const [name, value, expected] of cases) {
    const fixture = cloneMatrix();
    fixture['executableExemplars'] = value;
    assert.match(
      validateTestCoverageMatrix(fixture, repositoryRoot).map((diagnostic) => diagnostic.message).join('\n'),
      expected,
      name,
    );
  }
});

test('test coverage matrix independently rejects each executable exemplar path boundary', () => {
  const validEntries: Array<Record<string, string>> = expectedExemplars.map(([layer, path]) => ({ layer, path }));
  const cases = [
    ['drive-letter absolute path', validEntries.with(0, { layer: 'unit', path: 'C:\\tmp\\example.test.ts' }), /must be repository-relative/],
    ['empty path', validEntries.with(0, { layer: 'unit', path: '' }), /\.path must be non-empty strings/],
    ['empty path segment', validEntries.with(0, { layer: 'unit', path: 'src//pipeline-core/interpret.test.ts' }), /must be repository-relative/],
    ['duplicate path', validEntries.with(1, { layer: 'static-policy', path: validEntries[0]!.path }), /paths must be unique/],
    ['extra object key', validEntries.with(0, { layer: 'unit', path: validEntries[0]!.path, extra: 'rejected' }), /must contain only layer and path strings/],
  ] as const;

  for (const [name, value, expected] of cases) {
    const fixture = cloneMatrix();
    fixture['executableExemplars'] = value;
    assert.match(
      validateTestCoverageMatrix(fixture, repositoryRoot).map((diagnostic) => diagnostic.message).join('\n'),
      expected,
      name,
    );
  }
});

test('test coverage matrix does not classify an out-of-bucket E2E support test as unit', () => {
  const fixture = cloneMatrix();
  const exemplars = fixture['executableExemplars'] as Array<Record<string, unknown>>;
  exemplars[0] = { layer: 'unit', path: 'src/e2e/support/pipeline-context.test.ts' };
  assert.ok(validateTestCoverageMatrix(fixture, repositoryRoot).some((diagnostic) =>
    diagnostic.code === 'MATRIX_SHAPE' && diagnostic.message.includes('does not belong to exemplar layer unit')));
});
