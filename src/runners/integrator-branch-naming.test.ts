/**
 * integrator-branch-naming.test.ts — unit tests for branchName().
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { branchName, taskBranchPrefix } from './integrator-branch-naming.js';

// ─── canonical ────────────────────────────────────────────────────────────────

test('canonical: real-world taskId produces short feat/<shortid>-<slug>', () => {
  const result = branchName(
    'task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed',
    'docs(readme): how to add the revo MCP server to Claude Code and Codex',
  );
  assert.equal(result, 'feat/d29196ed-docs-readme-how-to-add-the-revo-mcp-serv');
  // must be far shorter than the old ~100-char form
  assert.ok(result.length < 60, `branch too long: ${result.length} chars`);
});

// ─── shortId extraction ───────────────────────────────────────────────────────

test('shortId: extracts the segment after the last underscore', () => {
  const result = branchName('task_20260101T000000000Z_some-slug_abcd1234', 'fix something');
  assert.ok(result.startsWith('feat/abcd1234-'), `expected abcd1234 prefix, got: ${result}`);
});

test('issueRef: branch keeps feat/<shortId>- prefix and includes issue number', () => {
  const result = branchName(
    'task_20260627T000000000Z_issue-ref-traceability_abcd1234',
    'Issue ref traceability',
    {
      repo: 'revisium/orchestrator',
      number: 147,
      url: 'https://github.com/revisium/orchestrator/issues/147',
    },
  );

  assert.equal(result, 'feat/abcd1234-issue-147-issue-ref-traceability');
  assert.ok(result.startsWith('feat/abcd1234-'));
});

// ─── taskBranchPrefix ─────────────────────────────────────────────────────────

test('taskBranchPrefix: returns feat/<shortId>- for a canonical taskId', () => {
  assert.equal(
    taskBranchPrefix('task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed'),
    'feat/d29196ed-',
  );
});

test('taskBranchPrefix: every branchName output starts with its taskBranchPrefix', () => {
  const taskId = 'task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed';
  const prefix = taskBranchPrefix(taskId);
  assert.ok(branchName(taskId, 'some title').startsWith(prefix));
  assert.ok(branchName(taskId, 'another title').startsWith(prefix));
});

// ─── determinism ─────────────────────────────────────────────────────────────

test('determinism: same inputs always produce the same branch (plan-0017 contract)', () => {
  const a = branchName('task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed', 'some title');
  const b = branchName('task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed', 'some title');
  assert.equal(a, b);
});

// ─── fallbacks ────────────────────────────────────────────────────────────────

test('fallback: taskId with no underscore uses sanitized whole id', () => {
  const result = branchName('task-001', 'Add feature X');
  assert.equal(result, 'feat/task-001-add-feature-x');
});

test('fallback: trailing underscore / empty suffix falls back to sanitized taskId', () => {
  const result = branchName('task_foo_', 'x');
  // trailing underscore → empty tail → falls back to slugify('task_foo_') = 'task-foo'
  assert.equal(result, 'feat/task-foo-x');
  assert.ok(!result.endsWith('-'), `must not end with '-': ${result}`);
});

// ─── edge cases ──────────────────────────────────────────────────────────────

test('empty title yields feat/<shortid> with no trailing hyphen', () => {
  const result = branchName('task_abc_def_1a2b3c4d', '');
  assert.equal(result, 'feat/1a2b3c4d');
  assert.ok(!result.endsWith('-'), `must not end with '-': ${result}`);
});

test('punctuation-only title yields feat/<shortid> with no trailing hyphen', () => {
  const result = branchName('task_abc_def_1a2b3c4d', '!!!---???');
  assert.equal(result, 'feat/1a2b3c4d');
  assert.ok(!result.endsWith('-'), `must not end with '-': ${result}`);
});

// ─── ref-validity invariants ──────────────────────────────────────────────────

const SAMPLES: [string, string][] = [
  ['task_20260624T075856661Z_docs-readme-how-to-ad_d29196ed', 'docs(readme): add the revo MCP server'],
  ['task-001', 'Add feature X'],
  ['task_foo_', 'x'],
  ['task_abc_def_1a2b3c4d', ''],
  ['task_abc_def_1a2b3c4d', 'UPPER CASE TITLE'],
  ['task_abc_def_1a2b3c4d', 'a'.repeat(100)],
];

for (const [taskId, title] of SAMPLES) {
  test(`ref-validity: branchName(${JSON.stringify(taskId)}, ${JSON.stringify(title).slice(0, 20)}…)`, () => {
    const result = branchName(taskId, title);
    assert.ok(result.startsWith('feat/'), `must start with feat/: ${result}`);
    assert.equal(result, result.toLowerCase(), `must be lowercase: ${result}`);
    assert.ok(!result.includes('//'), `must have no //: ${result}`);
    assert.ok(!result.endsWith('-'), `must not end with '-': ${result}`);
    // slug portion (after feat/<shortid>-) must be ≤ 40 chars
    const slugPart = result.replace(/^feat\/[^-]+-?/, '');
    assert.ok(slugPart.length <= 40, `slug part too long (${slugPart.length}): ${slugPart}`);
  });
}
