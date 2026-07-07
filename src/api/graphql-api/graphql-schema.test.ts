import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalize(value: string): string {
  return value.replace(/\r\n|\r/g, '\n').trim();
}

test('code-first GraphQL schema matches committed schema.graphql', async () => {
  const schemaMarker = '__REVO_GRAPHQL_SCHEMA_START__';
  await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { cwd: process.cwd() });
  const suffix = `${process.pid}`;
  const env = {
    ...process.env,
    REVO_DATA_DIR: mkdtempSync(join(tmpdir(), `revo-schema-${suffix}-`)),
    REVO_PORT: String(29_000 + (process.pid % 1_000)),
    REVO_PG_PORT: String(27_000 + (process.pid % 1_000)),
    REVO_DB: `revo_schema_${suffix}`,
    REVO_DBOS_DB: `dbos_schema_${suffix}`,
  };
  const { stdout } = await execFileAsync('node', [
    '--input-type=module',
    '-e',
    [
      "import 'reflect-metadata';",
      "import { ensureStorage, shutdownStorage } from './dist/storage/ensure-storage.js';",
      "import { NestFactory } from '@nestjs/core';",
      "import { GraphQLSchemaHost } from '@nestjs/graphql';",
      "import { printSchema } from 'graphql';",
      "import { GraphqlApiModule } from './dist/api/graphql-api/graphql-api.module.js';",
      'let app;',
      'try {',
      'await ensureStorage();',
      "app = await NestFactory.create(GraphqlApiModule, { logger: false });",
      'await app.init();',
      `console.log('${schemaMarker}');`,
      'console.log(printSchema(app.get(GraphQLSchemaHost).schema));',
      '} finally {',
      'if (app) await app.close().catch(() => undefined);',
      'await shutdownStorage();',
      '}',
    ].join(' '),
  ], { cwd: process.cwd(), env, maxBuffer: 1024 * 1024 });
  const markerIndex = stdout.lastIndexOf(schemaMarker);
  assert.notEqual(markerIndex, -1, 'schema marker must be present in child stdout');
  const actual = normalize(stdout.slice(markerIndex + schemaMarker.length));
  const expected = normalize(readFileSync(join(import.meta.dirname, 'schema.graphql'), 'utf8'));
  assert.equal(actual, expected);
});
