/**
 * diff.test.ts — the §12.13 template diff classifier (`classifyTemplateDiff`).
 *
 * Covers each classified case: safe (displayName/prompt/payload), breaking (delete, topology change,
 * entry change, scopes change), invalid (id reused with a different kind / resultSchema), and the
 * conservative default (an unclassified field change → breaking + DIFF_UNCLASSIFIED).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTemplateDiff } from './validate.js';
import { featureDevelopment, localChange, node } from './kit/index.js';

test('diff: identical templates → safe, no diagnostics', () => {
  const out = classifyTemplateDiff(featureDevelopment(), featureDevelopment());
  assert.equal(out.kind, 'safe');
  assert.equal(out.diagnostics.length, 0);
});

test('diff: a displayName change → safe', () => {
  const before = localChange();
  const next = localChange();
  (next.nodes['developer'] as { displayName?: string }).displayName = 'Senior developer';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'safe');
});

test('diff: a humanGate reason (prompt-like) change → safe', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  (next.nodes['planGate'] as { reason: string }).reason = 'plan-review (revised wording)';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'safe');
});

test('diff: deleting a node → breaking (DIFF_NODE_DELETED)', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  delete next.nodes['failedEnd'];
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
  assert.ok(out.diagnostics.some((d) => d.code === 'DIFF_NODE_DELETED' && d.nodeId === 'failedEnd'));
});

test('diff: changing a node kind (id reuse, different kind) → invalid (DIFF_ID_REUSED_INCOMPATIBLE)', () => {
  const before = localChange();
  const next = localChange();
  // Reuse id `developer` as a different kind.
  next.nodes['developer'] = node.script('developer', 'script:x', 'doneEnd');
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'invalid');
  assert.ok(out.diagnostics.some((d) => d.code === 'DIFF_ID_REUSED_INCOMPATIBLE'));
});

test('diff: changing a node resultSchema (same kind) → invalid', () => {
  const before = localChange();
  const next = localChange();
  (next.nodes['developer'] as { resultSchema?: string }).resultSchema = 'schema:different';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'invalid');
  assert.ok(out.diagnostics.some((d) => d.code === 'DIFF_ID_REUSED_INCOMPATIBLE'));
});

test('diff: changing an outgoing edge (topology) → breaking (DIFF_NODE_TOPOLOGY_CHANGED)', () => {
  const before = localChange();
  const next = localChange();
  // Repoint developer.next to a new terminal (add the node so refs still resolve).
  next.nodes['otherEnd'] = node.terminal('otherEnd', 'failed');
  (next.nodes['developer'] as { next: string }).next = 'otherEnd';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
  assert.ok(out.diagnostics.some((d) => d.code === 'DIFF_NODE_TOPOLOGY_CHANGED'));
});

test('diff: changing the entry → breaking', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  next.entry = 'developer';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
});

test('diff: changing scopes → breaking', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  next.scopes = { codeReviewLoop: { cap: 5, parent: null } }; // cap 3 → 5
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
});

test('diff: an UNCLASSIFIED field change defaults to breaking (DIFF_UNCLASSIFIED)', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  // Changing a guard set (branches) is topology; instead change a gate's `outcomes` (a non-safe,
  // non-topology field) → must default to breaking via the conservative DIFF_UNCLASSIFIED path.
  (next.nodes['planGate'] as { outcomes: string[] }).outcomes = ['approved'];
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
  assert.ok(out.diagnostics.some((d) => d.code === 'DIFF_UNCLASSIFIED'));
});

test('diff: changing onFailure (a non-safe field) → breaking via DIFF_UNCLASSIFIED', () => {
  const before = featureDevelopment();
  const next = featureDevelopment();
  (next.nodes['developer'] as { onFailure: string }).onFailure = 'escalate';
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'breaking');
});

test('diff: adding a brand-new node id → safe (additive)', () => {
  const before = localChange();
  const next = localChange();
  next.nodes['note'] = node.terminal('note', 'blocked'); // unreferenced add; classifier sees it as additive
  const out = classifyTemplateDiff(before, next);
  assert.equal(out.kind, 'safe');
});
