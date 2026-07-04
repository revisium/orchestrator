import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ISSUE_REF = /(?:^|[^\w])(?:issue\s*)?#\d{3,}\b/i;

function hasIssueRef(value: string): boolean {
  return ISSUE_REF.test(value);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:e2e\.)?test\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function hardSkipViolations(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const violations: string[] = [];
  for (const match of source.matchAll(/skip\s*:\s*([^,\n}]+)/g)) {
    const expression = match[1]?.trim() ?? '';
    if (expression === 'e2eSkip' || expression === 'false') continue;
    const literal = expression.match(/^['"`]([^'"`]+)['"`]$/)?.[1];
    if (literal && hasIssueRef(literal)) continue;
    violations.push(`${file}:${lineNumber(source, match.index ?? 0)} ${['skip', expression].join(': ')}`);
  }
  return violations;
}

test('hard skipped e2e tests carry a real issue ref', () => {
  assert.equal(hasIssueRef('invariant #5'), false, 'invariant references are not issue refs');
  assert.equal(hasIssueRef('#234: pending feature'), true);
  assert.equal(hasIssueRef('issue #276 pending'), true);

  const root = fileURLToPath(new URL('./', import.meta.url));
  const violations = sourceFiles(root).flatMap(hardSkipViolations);
  assert.deepEqual(violations, []);
});
