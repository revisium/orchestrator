import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const repoSchemaPath = new URL('../../prisma/schema.prisma', import.meta.url);

const ENGINE_REQUIRED_MODELS = [
  'Branch',
  'Revision',
  'Table',
  'Row',
  'FileBlob',
  'ProjectFileUsage',
  'TableMigration',
] as const;

const ALLOWED_REVO_ADDITIVE_LINES: Record<string, Set<string>> = {
  Branch: new Set([
    'revoProject RevoProject @relation(fields: [projectId], references: [id], onDelete: Restrict)',
    '@@index([projectId])',
  ]),
};

function normalizeEntry(entry: string): string {
  return entry
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\[\s+/g, '[')
    .replace(/\s+\]/g, ']')
    .replace(/\s*,\s*/g, ', ');
}

function delimiterBalance(value: string): number {
  let balance = 0;
  for (const char of value) {
    if (char === '(' || char === '[') balance += 1;
    if (char === ')' || char === ']') balance -= 1;
  }
  return balance;
}

function readModelEntries(schema: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  const modelRegex = /^model\s+(\w+)\s+\{([\s\S]*?)^}/gm;
  for (const match of schema.matchAll(modelRegex)) {
    const [, modelName, body] = match;
    const entries = new Set<string>();
    const current: string[] = [];
    let balance = 0;

    function flush(): void {
      const entry = normalizeEntry(current.join(' '));
      if (entry.length > 0 && !entry.startsWith('//')) entries.add(entry);
      current.length = 0;
      balance = 0;
    }

    for (const rawLine of body.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith('//')) continue;
      current.push(line);
      balance += delimiterBalance(line);
      if (balance <= 0) flush();
    }
    if (current.length > 0) flush();

    models.set(modelName, entries);
  }
  return models;
}

test('schema fragment comparison normalizes multiline Prisma attributes', () => {
  const singleLine = readModelEntries(`
model Example {
  id String @id
  left String
  right String
  @@unique([left, right])
}
`).get('Example');
  const multiLine = readModelEntries(`
model Example {
  id String @id
  left String
  right String
  @@unique([
    left,
    right
  ])
}
`).get('Example');

  assert.deepEqual(multiLine, singleLine);
});

test('Revo Prisma schema contains the pinned engine-required model fragment', () => {
  const engineRoot = dirname(require.resolve('@revisium/engine/package.json'));
  const engineSchema = readFileSync(join(engineRoot, 'prisma/schema.prisma'), 'utf8');
  const revoSchema = readFileSync(repoSchemaPath, 'utf8');

  const engineModels = readModelEntries(engineSchema);
  const revoModels = readModelEntries(revoSchema);
  const violations: string[] = [];

  for (const modelName of ENGINE_REQUIRED_MODELS) {
    const engineLines = engineModels.get(modelName);
    const revoLines = revoModels.get(modelName);
    if (!engineLines) {
      violations.push(`engine schema missing expected model ${modelName}`);
      continue;
    }
    if (!revoLines) {
      violations.push(`Revo schema missing engine-required model ${modelName}`);
      continue;
    }

    for (const line of engineLines) {
      if (!revoLines.has(line)) violations.push(`${modelName}: missing engine line: ${line}`);
    }

    const allowedAdditions = ALLOWED_REVO_ADDITIVE_LINES[modelName] ?? new Set<string>();
    for (const line of revoLines) {
      if (!engineLines.has(line) && !allowedAdditions.has(line)) {
        violations.push(`${modelName}: unexpected Revo-owned line in engine fragment: ${line}`);
      }
    }
  }

  assert.deepEqual(violations, [], violations.join('\n'));
});
