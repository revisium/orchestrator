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

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function readModelLines(schema: string): Map<string, Set<string>> {
  const models = new Map<string, Set<string>>();
  const modelRegex = /^model\s+(\w+)\s+\{([\s\S]*?)^}/gm;
  for (const match of schema.matchAll(modelRegex)) {
    const [, modelName, body] = match;
    models.set(
      modelName,
      new Set(
        body
          .split(/\r?\n/)
          .map(normalizeLine)
          .filter((line) => line.length > 0 && !line.startsWith('//')),
      ),
    );
  }
  return models;
}

test('Revo Prisma schema contains the pinned engine-required model fragment', () => {
  const engineRoot = dirname(require.resolve('@revisium/engine/package.json'));
  const engineSchema = readFileSync(join(engineRoot, 'prisma/schema.prisma'), 'utf8');
  const revoSchema = readFileSync(repoSchemaPath, 'utf8');

  const engineModels = readModelLines(engineSchema);
  const revoModels = readModelLines(revoSchema);
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
