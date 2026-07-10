import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
