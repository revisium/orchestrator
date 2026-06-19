/**
 * config.test.ts — runtime.json contract (audit §3.3).
 *
 * `revo` boot couples to `@revisium/standalone` through the runtime.json that `ensureRevisium`
 * (host/ensure-revisium.ts `startAndWaitForHealth`) WRITES and `readRuntime` / `resolvePorts` READ
 * back. These tests PIN the exact field set `revo` depends on — `{ httpPort, pgPort, pid, startedAt,
 * dataDir }` — plus the pid-proven port-resolution behavior, so a drift on either side (or a
 * `@revisium/standalone` bump that changes what we persist) fails loudly instead of silently breaking
 * boot. The package version is pinned in package.json for the same reason.
 *
 * Isolation: env overrides point `getConfig()` at a throwaway data dir + preferred ports BEFORE the
 * first `getConfig()` call (it caches). node:test runs each file in its own process, so these env
 * writes are file-local.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { readRuntime, resolvePorts } from './config.js';

const TMP = mkdtempSync(join(os.tmpdir(), 'revo-config-contract-'));
process.env['REVO_DATA_DIR'] = TMP;
process.env['REVO_PORT'] = '29999';
process.env['REVO_PG_PORT'] = '25999';

const RUNTIME_FILE = join(TMP, 'runtime.json');

// The exact shape `ensureRevisium` persists (host/ensure-revisium.ts):
//   JSON.stringify({ httpPort, pgPort, pid: child.pid, startedAt, dataDir })
const CONTRACT = {
  httpPort: 19222,
  pgPort: 15440,
  pid: process.pid, // a live pid (this test process)
  startedAt: '2026-06-19T00:00:00.000Z',
  dataDir: TMP,
};

after(() => rmSync(TMP, { recursive: true, force: true }));

test('runtime.json contract: readRuntime parses the { httpPort, pgPort, pid, startedAt, dataDir } shape', () => {
  writeFileSync(RUNTIME_FILE, JSON.stringify(CONTRACT));
  const rt = readRuntime();
  assert.ok(rt, 'a well-formed runtime.json must parse');
  assert.equal(rt.httpPort, CONTRACT.httpPort);
  assert.equal(rt.pgPort, CONTRACT.pgPort);
  assert.equal(rt.pid, CONTRACT.pid);
  assert.equal(rt.startedAt, CONTRACT.startedAt);
  assert.equal(rt.dataDir, CONTRACT.dataDir);
});

test('runtime.json contract: readRuntime returns null on a corrupt file (readers fall back, never throw)', () => {
  writeFileSync(RUNTIME_FILE, '{ not valid json');
  assert.equal(readRuntime(), null);
});

test('runtime.json contract: resolvePorts trusts the persisted ports when the daemon pid is alive', async () => {
  writeFileSync(RUNTIME_FILE, JSON.stringify({ ...CONTRACT, pid: process.pid }));
  // The persisted ports differ from the preferred ones (29999/25999) — proving resolvePorts used the
  // pid-proven runtime, not the config fallback.
  assert.deepEqual(await resolvePorts(), { httpPort: 19222, pgPort: 15440 });
});

test('runtime.json contract: resolvePorts ignores stale ports and falls back to preferred when the pid is dead', async () => {
  // A pid that cannot be alive → resolvePorts must NOT trust the persisted (stale) ports.
  writeFileSync(RUNTIME_FILE, JSON.stringify({ ...CONTRACT, pid: 2_147_483_646 }));
  assert.deepEqual(await resolvePorts(), { httpPort: 29999, pgPort: 25999 });
});
