import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function normalizeSchema(schema: string): string {
  return schema.replace(/\r\n/g, '\n').trim();
}

test('committed Prisma client inline schema matches prisma/schema.prisma', () => {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  const generatedClass = readFileSync(
    new URL('../__generated__/client/internal/class.ts', import.meta.url),
    'utf8',
  );

  const inlineSchemaMatch = generatedClass.match(/"inlineSchema":\s*"((?:\\.|[^"\\])*)"/);
  assert.ok(inlineSchemaMatch, 'generated Prisma client must contain inlineSchema');

  const inlineSchema = JSON.parse(`"${inlineSchemaMatch[1]}"`) as string;
  assert.equal(normalizeSchema(inlineSchema), normalizeSchema(schema));
});

test('generated client exposes the RevoRepository relation and schema constraints', () => {
  const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /repositories\s+RevoRepository\[\]/);
  assert.match(schema, /model RevoRepository/);
  assert.match(schema, /project\s+RevoProject\s+@relation\(fields: \[projectId\], references: \[id\], onDelete: Restrict\)/);
  assert.match(schema, /@@unique\(\[projectId, name\]\)/);
  const generated = readFileSync(new URL('../__generated__/client/models/RevoRepository.ts', import.meta.url), 'utf8');
  assert.match(generated, /RevoRepository/);
});
