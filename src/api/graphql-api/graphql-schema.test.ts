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
  const schemaMarker = '__REVO_GRAPHQL_SCHEMA_START__';
  await execFileAsync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: process.cwd(),
  });
  const schemaScript = [
    "import 'reflect-metadata';",
    "import { NestFactory } from '@nestjs/core';",
    "import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';",
    "import { lexicographicSortSchema, printSchema } from 'graphql';",
    "import { InboxResolver } from './dist/api/graphql-api/inbox/inbox.resolver.js';",
    "import { InboxSubscriptionResolver } from './dist/api/graphql-api/inbox/inbox-subscription.resolver.js';",
    "import { MethodResolver } from './dist/api/graphql-api/method/method.resolver.js';",
    "import { PrResolver } from './dist/api/graphql-api/pr/pr.resolver.js';",
    "import { RunDigestResolver } from './dist/api/graphql-api/runs/run-digest.resolver.js';",
    "import { RunEventsResolver } from './dist/api/graphql-api/runs/run-events.resolver.js';",
    "import { RunProgressResolver } from './dist/api/graphql-api/runs/run-progress.resolver.js';",
    "import { RunsResolver } from './dist/api/graphql-api/runs/runs.resolver.js';",
    "import { RunsSubscriptionResolver } from './dist/api/graphql-api/runs/runs-subscription.resolver.js';",
    "import { SystemResolver } from './dist/api/graphql-api/system/system.resolver.js';",
    "import { registerGraphqlEnums } from './dist/api/graphql-api/registerGraphqlEnums.js';",
    'registerGraphqlEnums();',
    'const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });',
    'try {',
    'await app.init();',
    'const factory = app.get(GraphQLSchemaFactory);',
    'const schema = await factory.create([',
    'InboxResolver, InboxSubscriptionResolver, MethodResolver, PrResolver,',
    'RunDigestResolver, RunEventsResolver, RunProgressResolver, RunsResolver, RunsSubscriptionResolver, SystemResolver,',
    '], { skipCheck: true });',
    `console.log('${schemaMarker}');`,
    'console.log(printSchema(lexicographicSortSchema(schema)));',
    '} finally {',
    'await app.close().catch(() => undefined);',
    '}',
  ].join(' ');
  const { stdout } = await execFileAsync(
    'node',
    ['--input-type=module', '-e', schemaScript],
    { cwd: process.cwd(), maxBuffer: 1024 * 1024 },
  );
  const markerIndex = stdout.lastIndexOf(schemaMarker);
  assert.notEqual(
    markerIndex,
    -1,
    'schema marker must be present in child stdout',
  );
  const actual = normalize(stdout.slice(markerIndex + schemaMarker.length));
  const expected = normalize(
    readFileSync(join(import.meta.dirname, 'schema.graphql'), 'utf8'),
  );
  assert.equal(actual, expected);
  assert.match(expected, /type RunProfileModel \{[\s\S]*?status: RunProfileStatus!/);
  assert.match(expected, /type RunProfileModel \{[\s\S]*?profileRevisionHash: String!/);
  assert.match(expected, /input CreateRunProfileInput \{[\s\S]*?status: RunProfileStatus/);
  assert.match(expected, /input UpdateRunProfileInput \{[\s\S]*?status: RunProfileStatus/);
});
