import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { repoRoot } from '../../config.js';
import {
  focusedCaseOwnership,
  focusedCaseTitle,
  nonDslCaseManifest,
  nonDslPipelineCaseAttachment,
  validateNonDslPipelineCaseAttachment,
} from './non-dsl-ownership.js';

const expectedCases = [
  'B5', 'B6', 'B7', 'B9',
  'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I9b', 'I10', 'I10b', 'I11',
  'H4', 'H8', 'H9', 'H9b', 'H9c', 'H9d', 'H12', 'H12b', 'H12c',
];
const expectedPipelineCases = [
  'C1', 'C2', 'C3', 'C4',
  'L1', 'L4', 'L3',
  'K1', 'K2', 'K4',
  'B3', 'B4', 'B10', 'B13', 'B12',
  'D11', 'D9', 'D10', 'D20', 'D2', 'D14', 'D14b', 'D7', 'D13', 'D15', 'D19', 'D35', 'D30',
  'D31', 'D32', 'D33',
  'N1', 'N2', 'N3', 'N4',
  'RG234-A', 'RG234-B', 'RG234-C',
] as const;

test('focused/static consolidation retains every non-representative routing and MCP case exactly once', () => {
  const ids = focusedCaseOwnership.map((entry) => entry.caseId);
  assert.deepEqual([...ids].sort(), [...expectedCases].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('canonical non-DSL manifest retains every pipeline and focused attachment exactly once', () => {
  const ids = nonDslCaseManifest.map((entry) => entry.caseId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort(),
    [...expectedPipelineCases, ...expectedCases].sort(),
  );

  for (const caseId of expectedPipelineCases) {
    const attachment = nonDslPipelineCaseAttachment(caseId);
    assert.equal(Object.isFrozen(attachment), true);
    assert.equal(attachment.ownerLayer, 'pipeline-dsl');
    assert.doesNotThrow(() => validateNonDslPipelineCaseAttachment(attachment));
  }
});

test('focused ownership construction rejects attachment to a different executable owner', () => {
  assert.throws(
    () => focusedCaseTitle('H8', 'src/task-control-plane/task-control-plane-api.service.test.ts', 'wrong owner'),
    /belongs to src\/mcp\/mcp-facade.service.test.ts/,
  );
});

test('focused/static ownership points only at repository-relative focused evidence', () => {
  for (const entry of focusedCaseOwnership) {
    assert.equal(entry.ownerSurface.startsWith('/') || entry.ownerSurface.includes('..'), false, entry.caseId);
    assert.equal(entry.ownerSurface.includes('/e2e/'), false, `${entry.caseId} must not claim representative E2E ownership`);
    assert.equal(existsSync(resolve(repoRoot, entry.ownerSurface)), true, `${entry.caseId}: ${entry.ownerSurface}`);
    assert.ok(entry.retainedBehavior.length > 10, `${entry.caseId} needs an explicit retained behavior`);
  }
});
