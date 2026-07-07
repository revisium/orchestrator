/**
 * config.test.ts — profile and port contract.
 *
 * Isolation: env overrides point `getConfig()` at a throwaway data dir + preferred ports BEFORE the
 * first `getConfig()` call (it caches). node:test runs each file in its own process, so these env
 * writes are file-local.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { resolveDefaultGraphqlPort, resolveProfileConfig, resolveProfileName } from './config.js';

const TMP = mkdtempSync(join(os.tmpdir(), 'revo-config-contract-'));
process.env['REVO_DATA_DIR'] = TMP;
process.env['REVO_PORT'] = '29999';
process.env['REVO_PG_PORT'] = '25999';

after(() => rmSync(TMP, { recursive: true, force: true }));

test('resolveDefaultGraphqlPort derives GraphQL from the Revo base port', () => {
  assert.equal(resolveDefaultGraphqlPort(), 30000);
});

// ── Profiles (pure resolvers — pass env explicitly so they ignore the file-level cache/env) ────

test('profiles: resolveProfileName defaults to `default`, accepts `dev`, rejects unknown', () => {
  assert.equal(resolveProfileName({}), 'default');
  assert.equal(resolveProfileName({ REVO_PROFILE: '' }), 'default');
  assert.equal(resolveProfileName({ REVO_PROFILE: 'dev' }), 'dev');
  assert.throws(() => resolveProfileName({ REVO_PROFILE: 'prod' }), /Unknown REVO_PROFILE 'prod'/);
});

test('profiles: dev shifts the band off the committed defaults (+400 ports, -dev data dir)', () => {
  const raw = { dataDir: '~/.revisium-orchestrator', preferredPort: 19222, preferredPgPort: 15440 };
  assert.deepEqual(resolveProfileConfig(raw, { REVO_PROFILE: 'dev' }), {
    profile: 'dev',
    dataDir: '~/.revisium-orchestrator-dev',
    preferredPort: 19622,
    preferredPgPort: 15840,
  });
  assert.deepEqual(resolveProfileConfig(raw, {}), {
    profile: 'default',
    dataDir: '~/.revisium-orchestrator',
    preferredPort: 19222,
    preferredPgPort: 15440,
  });
});

test('profiles: explicit REVO_* env overrides the profile band per knob', () => {
  const raw = { dataDir: '~/.revisium-orchestrator', preferredPort: 19222, preferredPgPort: 15440 };
  const resolved = resolveProfileConfig(raw, { REVO_PROFILE: 'dev', REVO_PORT: '40000', REVO_DATA_DIR: '/tmp/custom' });
  assert.equal(resolved.preferredPort, 40000); // explicit REVO_PORT wins over the dev band 19622
  assert.equal(resolved.dataDir, '/tmp/custom'); // explicit REVO_DATA_DIR wins over the -dev suffix
  assert.equal(resolved.preferredPgPort, 15840); // unset → dev band still applies
});
