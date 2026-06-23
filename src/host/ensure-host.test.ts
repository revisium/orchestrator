/**
 * ensure-host.test.ts — the pure, deterministic seams of ensureHost.
 * The attach-or-spawn integration (spawning a real detached daemon, GraphQL health, stop) is
 * covered by the real-app run and the e2e suite; here we pin the dev/prod spawn split and the
 * GraphQL-port resolution, which must not drift.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(join(os.tmpdir(), 'revo-ensure-host-'));
process.env['REVO_DATA_DIR'] = TMP;
process.env['REVO_PORT'] = '29000';
delete process.env['REVO_PROFILE'];
delete process.env['REVO_GRAPHQL_PORT'];

import { daemonSpawnArgv, expectedGraphqlPort, isGraphqlHealthy } from './ensure-host.js';

after(() => rmSync(TMP, { recursive: true, force: true }));

test('daemonSpawnArgv: dev (.ts entry) re-invokes node with the tsx loader', () => {
  const [cmd, args] = daemonSpawnArgv('/x/src/cli/index.ts');
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ['--import', 'tsx', '/x/src/cli/index.ts', '__daemon']);
});

test('daemonSpawnArgv: prod (.js entry) re-invokes node directly (no loader)', () => {
  const [cmd, args] = daemonSpawnArgv('/x/dist/cli/index.js');
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args, ['/x/dist/cli/index.js', '__daemon']);
});

test('expectedGraphqlPort: REVO_GRAPHQL_PORT wins; otherwise derives httpPort+1', () => {
  process.env['REVO_GRAPHQL_PORT'] = '40000';
  assert.equal(expectedGraphqlPort(), 40000);
  delete process.env['REVO_GRAPHQL_PORT'];
  assert.equal(expectedGraphqlPort(), 29001); // preferredPort 29000 + GRAPHQL_PORT_OFFSET
});

test('isGraphqlHealthy: an unreachable port resolves false (never throws)', async () => {
  assert.equal(await isGraphqlHealthy(1), false);
});
