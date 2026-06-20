import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function normalize(value: string): string {
  return value.replace(/\r\n|\r/g, '\n').trim();
}

test('code-first GraphQL schema matches committed schema.graphql', async () => {
  await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], { cwd: process.cwd() });
  const { stdout } = await execFileAsync('node', [
    '--input-type=module',
    '-e',
    [
      "import 'reflect-metadata';",
      "import { NestFactory } from '@nestjs/core';",
      "import { GraphQLSchemaHost } from '@nestjs/graphql';",
      "import { printSchema } from 'graphql';",
      "import { GraphqlApiModule } from './dist/api/graphql-api/graphql-api.module.js';",
      "const app = await NestFactory.create(GraphqlApiModule, { logger: false });",
      'await app.init();',
      'console.log(printSchema(app.get(GraphQLSchemaHost).schema));',
      'await app.close();',
    ].join(' '),
  ], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
  const actual = normalize(stdout);
  const expected = normalize(readFileSync(join(import.meta.dirname, 'schema.graphql'), 'utf8'));
  assert.equal(actual, expected);
});
