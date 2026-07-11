import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

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

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function stringLiteralValue(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  return undefined;
}

function hardSkipViolationsInSource(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'test') {
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property) || propertyNameText(property.name) !== 'skip') continue;
          const expression = property.initializer.getText(sourceFile).trim();
          if (expression === 'e2eSkip' || expression === 'false') continue;
          const literal = stringLiteralValue(property.initializer);
          if (literal && hasIssueRef(literal)) continue;
          violations.push(`${file}:${lineNumber(source, property.name.getStart(sourceFile))} ${['skip', expression].join(': ')}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
}

function hardSkipViolations(file: string): string[] {
  return hardSkipViolationsInSource(file, readFileSync(file, 'utf8'));
}

test('hard skipped e2e tests carry a real issue ref', () => {
  assert.equal(hasIssueRef('invariant #5'), false, 'invariant references are not issue refs');
  assert.equal(hasIssueRef('#234: pending feature'), true);
  assert.equal(hasIssueRef('issue #276 pending'), true);
  assert.deepEqual(hardSkipViolationsInSource('fixture.ts', ['const fixture = { ', 'skip', ': "pending" };'].join('')), []);
  assert.deepEqual(
    hardSkipViolationsInSource('fixture.ts', ['test("x", { ', 'skip', ': "pending" }, () => {})'].join('')),
    ['fixture.ts:1 skip: "pending"'],
  );
  assert.deepEqual(
    hardSkipViolationsInSource('fixture.ts', ['test("x", { timeout: 1000, ', 'skip', ': "pending" }, () => {})'].join('')),
    ['fixture.ts:1 skip: "pending"'],
  );

  const root = fileURLToPath(new URL('../../e2e/', import.meta.url));
  const violations = sourceFiles(root).flatMap(hardSkipViolations);
  assert.deepEqual(violations, []);
});
