/**
 * host-runtime.test.ts — `host.json` contract for the host daemon's tracked identity.
 *
 * Isolation: env points getConfig() at a throwaway data dir BEFORE the first call (it caches);
 * node:test runs each file in its own process, so these env writes are file-local.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(join(os.tmpdir(), 'revo-host-runtime-'));
process.env['REVO_DATA_DIR'] = TMP;
delete process.env['REVO_PROFILE'];

// Static import is safe: getConfig() is lazy (not called at module load), so the env above wins.
import {
  readHostRuntime,
  writeHostRuntime,
  removeHostRuntime,
  removeHostRuntimeIfMatches,
  isHostRunning,
  hostRuntimeFile,
} from './host-runtime.js';

after(() => rmSync(TMP, { recursive: true, force: true }));

const STATE = { pid: process.pid, graphqlPort: 19223, mcpPort: 19224, startedAt: '2026-06-23T00:00:00.000Z', profile: 'default' };

test('host-runtime: write → read round-trips the { pid, graphqlPort, startedAt, profile } shape', () => {
  writeHostRuntime(STATE);
  assert.deepEqual(readHostRuntime(), STATE);
});

test('host-runtime: readHostRuntime returns null when absent or corrupt (readers never throw)', () => {
  removeHostRuntime();
  assert.equal(readHostRuntime(), null);
  writeFileSync(hostRuntimeFile(), '{ not valid json');
  assert.equal(readHostRuntime(), null);
});

test('host-runtime: isHostRunning is true for a live pid, false for a dead one', () => {
  writeHostRuntime({ ...STATE, pid: process.pid });
  assert.equal(isHostRunning(), true);
  writeHostRuntime({ ...STATE, pid: 2_147_483_646 });
  assert.equal(isHostRunning(), false);
});

test('host-runtime: removeHostRuntimeIfMatches deletes only on a pid+startedAt identity match', () => {
  writeHostRuntime({ ...STATE, pid: 111, startedAt: 'A' });
  removeHostRuntimeIfMatches({ pid: 111, startedAt: 'B' }); // startedAt differs → keep
  assert.ok(readHostRuntime(), 'must not delete a runtime that no longer matches');
  removeHostRuntimeIfMatches({ pid: 111, startedAt: 'A' }); // exact match → delete
  assert.equal(readHostRuntime(), null);
});
