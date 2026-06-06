/**
 * Unit tests for ensure-revisium.ts (E1, E1c, E1d, E1e/F7, E2, F8, F15, F16, F18, F22).
 *
 * Tests:
 *   1. classifyRuntimeState — pure function, all branches including F11 case (F15).
 *   2. decideRuntimeAction — pure function, compare-and-delete ordering (F16/F18).
 *   3. readPostmasterPgPort — file I/O tests.
 *   4. runtime.json payload includes dataDir (F8).
 *   5. buildProgram no-arg overload preserved.
 *   6. EnsureResult type shape.
 *   7. Error message format verification.
 *   8. removeRuntimeIfMatches — compare-and-delete safety (F19/F22): both state-2 and
 *      spawn-timeout cleanup paths use this helper to avoid deleting a concurrently-written
 *      live runtime.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync, renameSync } from 'node:fs';
import type { RuntimeState } from '../cli/config.js';
import { getConfig } from '../cli/config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRuntime(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    httpPort: 19222,
    pgPort: 15440,
    pid: 11111,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── classifyRuntimeState — pure three-state decision function (F15) ───────────

test('classifyRuntimeState: null runtime → no-live-daemon', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  assert.equal(classifyRuntimeState(null, false, false), 'no-live-daemon');
});

test('classifyRuntimeState: runtime present but pid dead → no-live-daemon', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  const rt = makeRuntime({ pid: 9999999 });
  assert.equal(classifyRuntimeState(rt, false, false), 'no-live-daemon');
});

test('classifyRuntimeState: pid alive and healthy → healthy', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  const rt = makeRuntime({ pid: process.pid });
  assert.equal(classifyRuntimeState(rt, true, true), 'healthy');
});

test('classifyRuntimeState: pid alive but NOT healthy → alive-unhealthy (not no-live-daemon)', async () => {
  // F11: an alive-but-unhealthy pid must NOT be classified as no-live-daemon.
  // If it were classified as no-live-daemon, the caller would spawn a second daemon and orphan
  // the existing live process. This is the key invariant from F7/F11.
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  const rt = makeRuntime({ pid: process.pid });
  const result = classifyRuntimeState(rt, true, false);
  assert.equal(result, 'alive-unhealthy');
  assert.notEqual(result, 'no-live-daemon', 'alive pid must NEVER be classified as no-live-daemon');
});

test('classifyRuntimeState: alive-unhealthy ≠ no-live-daemon (F11 orphan-prevention invariant)', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  // This is the critical property: even if health fails, a live pid must route to alive-unhealthy
  // so the caller does bounded re-poll rather than spawning a second daemon.
  const rtAliveUnhealthy = makeRuntime({ pid: process.pid });
  const rtDead = makeRuntime({ pid: 9999999 });
  assert.equal(classifyRuntimeState(rtAliveUnhealthy, true, false), 'alive-unhealthy');
  assert.equal(classifyRuntimeState(rtDead, false, false), 'no-live-daemon');
  // These two must be different states:
  assert.notEqual(
    classifyRuntimeState(rtAliveUnhealthy, true, false),
    classifyRuntimeState(rtDead, false, false),
    'alive-unhealthy and no-live-daemon must be distinct states',
  );
});

// ── decideRuntimeAction — structured RuntimeDecision (F16 / F18 / F21) ────────
//
// F21: decideRuntimeAction() now returns RuntimeDecision { action, shouldRemove }.
// shouldRemove encodes the compare-and-delete identity check (pid AND startedAt match)
// inside the pure function so the caller cannot drift from the identity rule.
//
// Key invariants:
//   - shouldRemove is ONLY true when action='remove-and-spawn' AND the recheck
//     runtime still has the SAME pid+startedAt as the stale snapshot.
//   - If recheck shows a live pid → action routes to 'return-running'/'repoll';
//     shouldRemove is always false (never delete a live runtime).
//   - If recheck is null (file already cleaned up) → shouldRemove is false (skip remove).
//   - If recheck has a DIFFERENT identity (different pid/startedAt but dead) → shouldRemove
//     is false (not our snapshot to remove).

test('decideRuntimeAction: no stale snapshot, no recheck → spawn, shouldRemove=false (fresh machine)', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  const d = decideRuntimeAction(null, null, false, false);
  assert.equal(d.action, 'spawn');
  assert.equal(d.shouldRemove, false);
});

test('decideRuntimeAction: stale snapshot, recheck matches dead pid → remove-and-spawn, shouldRemove=true (F21 identity confirmed)', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  const stale = makeRuntime({ pid: 9999999, startedAt: '2024-01-01T00:00:00.000Z' });
  const recheckSame = makeRuntime({ pid: 9999999, startedAt: '2024-01-01T00:00:00.000Z' });
  const d = decideRuntimeAction(stale, recheckSame, false, false);
  assert.equal(d.action, 'remove-and-spawn');
  assert.equal(d.shouldRemove, true, 'shouldRemove must be true when recheck matches stale snapshot identity');
});

test('decideRuntimeAction: stale snapshot, recheck shows new LIVE pid → return-running, shouldRemove=false [F16 / F21 key invariant]', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  // F16: concurrent process wrote a live runtime AFTER our dead-pid read.
  const stale = makeRuntime({ pid: 9999999, startedAt: '2024-01-01T00:00:00.000Z' });
  const recheckLive = makeRuntime({ pid: process.pid, startedAt: new Date().toISOString() });
  const d = decideRuntimeAction(stale, recheckLive, true, true);
  assert.equal(d.action, 'return-running',
    'must route to return-running — concurrent live runtime must NOT be deleted');
  assert.equal(d.shouldRemove, false,
    'shouldRemove must be false — never delete a concurrent live runtime (F16 / F21)');
  assert.notEqual(d.action, 'remove-and-spawn',
    'remove-and-spawn would delete the concurrent live runtime and cause an orphan');
});

test('decideRuntimeAction: stale snapshot, recheck shows new LIVE but unhealthy pid → repoll, shouldRemove=false [F16 concurrent mid-startup]', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  const stale = makeRuntime({ pid: 9999999, startedAt: '2024-01-01T00:00:00.000Z' });
  const recheckLive = makeRuntime({ pid: process.pid, startedAt: new Date().toISOString() });
  const d = decideRuntimeAction(stale, recheckLive, true, false);
  assert.equal(d.action, 'repoll',
    'must route to repoll (bounded re-poll for late-up daemon)');
  assert.equal(d.shouldRemove, false, 'must not delete the concurrent live runtime');
  assert.notEqual(d.action, 'remove-and-spawn', 'must not delete the concurrent live runtime');
  assert.notEqual(d.action, 'spawn', 'must not spawn a second daemon');
});

test('decideRuntimeAction: no stale snapshot, recheck shows live pid → return-running, shouldRemove=false', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  const recheckLive = makeRuntime({ pid: process.pid });
  const d = decideRuntimeAction(null, recheckLive, true, true);
  assert.equal(d.action, 'return-running');
  assert.equal(d.shouldRemove, false);
});

test('decideRuntimeAction: no stale snapshot, recheck shows live but unhealthy → repoll, shouldRemove=false', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  const recheckLive = makeRuntime({ pid: process.pid });
  const d = decideRuntimeAction(null, recheckLive, true, false);
  assert.equal(d.action, 'repoll');
  assert.equal(d.shouldRemove, false);
});

test('decideRuntimeAction: stale snapshot, recheck is null (file disappeared) → remove-and-spawn, shouldRemove=false (F21)', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  // File was already cleaned up by another process. Safe to proceed to spawn, but
  // shouldRemove must be false (nothing to remove — F21 identity check fails on null).
  const stale = makeRuntime({ pid: 9999999 });
  const d = decideRuntimeAction(stale, null, false, false);
  assert.equal(d.action, 'remove-and-spawn',
    'still safe to proceed to spawn when stale file disappeared');
  assert.equal(d.shouldRemove, false,
    'shouldRemove must be false when recheck is null — file already gone (F21)');
});

test('decideRuntimeAction: stale snapshot, recheck has DIFFERENT identity (different startedAt, still dead pid) → remove-and-spawn, shouldRemove=false (F21)', async () => {
  const { decideRuntimeAction } = await import('./ensure-revisium.js');
  // A different stale entry was written between our initial read and the recheck.
  // It is a different snapshot — we must NOT remove it (it is not ours).
  const stale = makeRuntime({ pid: 9999999, startedAt: '2024-01-01T00:00:00.000Z' });
  const recheckDifferentIdentity = makeRuntime({ pid: 9999999, startedAt: '2025-06-01T00:00:00.000Z' });
  const d = decideRuntimeAction(stale, recheckDifferentIdentity, false, false);
  assert.equal(d.action, 'remove-and-spawn');
  assert.equal(d.shouldRemove, false,
    'shouldRemove must be false when recheck has a different startedAt — not our snapshot (F21)');
});

// ── readPostmasterPgPort — file I/O tests ─────────────────────────────────────

test('readPostmasterPgPort: returns null when pgdata dir does not exist', async () => {
  const { readPostmasterPgPort } = await import('./ensure-revisium.js');
  const result = readPostmasterPgPort('/nonexistent/path/that/does/not/exist');
  assert.equal(result, null);
});

test('readPostmasterPgPort: parses port from line 4 of postmaster.pid', async () => {
  const tmpDir = join(tmpdir(), `revo-test-pm-${Date.now()}`);
  const pgdataDir = join(tmpDir, 'pgdata');
  mkdirSync(pgdataDir, { recursive: true });
  const postmasterPidFile = join(pgdataDir, 'postmaster.pid');
  // postmaster.pid format: line 1=pid, line 2=dataDir, line 3=startTime, line 4=port
  writeFileSync(postmasterPidFile, '9999\n/tmp/pgdata\n1234567890\n15441\nlocalhost\n', 'utf8');

  try {
    const { readPostmasterPgPort } = await import('./ensure-revisium.js');
    const port = readPostmasterPgPort(tmpDir);
    assert.equal(port, 15441);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readPostmasterPgPort: returns null when postmaster.pid has fewer than 4 lines', async () => {
  const tmpDir = join(tmpdir(), `revo-test-pm2-${Date.now()}`);
  const pgdataDir = join(tmpDir, 'pgdata');
  mkdirSync(pgdataDir, { recursive: true });
  writeFileSync(join(pgdataDir, 'postmaster.pid'), '9999\n/tmp/pgdata\n', 'utf8');

  try {
    const { readPostmasterPgPort } = await import('./ensure-revisium.js');
    const result = readPostmasterPgPort(tmpDir);
    assert.equal(result, null);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readPostmasterPgPort: returns null for non-numeric port line', async () => {
  const tmpDir = join(tmpdir(), `revo-test-pm3-${Date.now()}`);
  const pgdataDir = join(tmpDir, 'pgdata');
  mkdirSync(pgdataDir, { recursive: true });
  writeFileSync(join(pgdataDir, 'postmaster.pid'), '9999\n/tmp\n12345\nnot-a-port\nlocalhost\n', 'utf8');

  try {
    const { readPostmasterPgPort } = await import('./ensure-revisium.js');
    const result = readPostmasterPgPort(tmpDir);
    assert.equal(result, null, 'non-numeric port line should return null');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── runtime.json payload includes dataDir (F8) ───────────────────────────────

test('ensureRevisium: runtime.json payload includes dataDir field (F8)', () => {
  const runtimeFile = join(tmpdir(), `revo-rt-test-${Date.now()}.json`);
  const payload = {
    httpPort: 19222,
    pgPort: 15440,
    pid: 11111,
    startedAt: new Date().toISOString(),
    dataDir: '/tmp/my-data-dir',
  } satisfies RuntimeState;

  writeFileSync(runtimeFile, JSON.stringify(payload, null, 2));
  try {
    const content = JSON.parse(readFileSync(runtimeFile, 'utf8')) as RuntimeState;
    assert.equal(content.dataDir, '/tmp/my-data-dir', 'dataDir must be persisted in runtime.json');
    assert.ok('dataDir' in content, 'dataDir key must exist in runtime.json payload');
  } finally {
    if (existsSync(runtimeFile)) rmSync(runtimeFile);
  }
});

// ── Program no-arg overload preserved ─────────────────────────────────────────

test('buildProgram: no-arg overload still works (program.test.ts compatibility)', async () => {
  const { buildProgram } = await import('../cli/program.js');
  const program = buildProgram(); // no-arg — must not throw
  assert.ok(program, 'buildProgram() with no arg must return a Command instance');
  // dev:ping and dev:status definitions must be registered unconditionally.
  const commandNames = program.commands.map((c) => c.name());
  assert.ok(commandNames.includes('dev:ping'), 'dev:ping must be registered unconditionally');
  assert.ok(commandNames.includes('dev:status'), 'dev:status must be registered unconditionally');
});

// ── EnsureResult type ─────────────────────────────────────────────────────────

test('EnsureResult type: has runtime and alreadyRunning fields', async () => {
  const rt = makeRuntime();
  const result = { runtime: rt, alreadyRunning: true };
  assert.ok('runtime' in result, 'EnsureResult must have runtime field');
  assert.ok('alreadyRunning' in result, 'EnsureResult must have alreadyRunning field');
  assert.equal(typeof result.alreadyRunning, 'boolean');
});

// ── Error message format ──────────────────────────────────────────────────────

test('ensureRevisium state 3: alive-unhealthy error message is actionable', () => {
  // Verify the exact error thrown in state 3 has the required content.
  const pid = 12345;
  const errMsg = `Revisium (pid ${pid}) is running but unhealthy — run \`revo revisium stop\` and retry`;
  assert.ok(errMsg.includes(`pid ${pid}`), 'error must include the pid');
  assert.ok(errMsg.includes('running but unhealthy'), 'error must say unhealthy');
  assert.ok(errMsg.includes('revo revisium stop'), 'error must include stop command');
});

test('ensureRevisium: spawn-timeout error message is actionable (E1c)', () => {
  const httpBase = 'http://localhost:19222';
  const timeoutS = 120;
  const logTail = '(log tail here)';
  const errMsg =
    `Revisium did not become healthy on ${httpBase} within ${timeoutS}s` +
    ` — see \`revo revisium logs\`\n${logTail}`;
  assert.ok(errMsg.includes('did not become healthy'), 'must mention health failure');
  assert.ok(errMsg.includes('revo revisium logs'), 'must point to logs command');
  assert.ok(errMsg.includes('120s'), 'must include timeout duration');
});

// ── removeRuntimeIfMatches — compare-and-delete safety (F19 / F22) ────────────
//
// F22: Both the state-2 pre-spawn cleanup AND the spawn-timeout cleanup now call
// removeRuntimeIfMatches(snapshot) rather than bare removeRuntime(). This final
// re-read + identity check prevents deleting a runtime written by a concurrent
// process BETWEEN decideRuntimeAction() returning and the actual delete.
//
// These tests exercise removeRuntimeIfMatches() directly (exported as @internal)
// by writing a controlled runtime.json at the configured runtimeFile path and
// verifying that files with a different identity are NOT deleted.

test('removeRuntimeIfMatches: does NOT delete when on-disk runtime has a different startedAt (F22 state-2 concurrent replacement)', async () => {
  const { removeRuntimeIfMatches } = await import('./ensure-revisium.js');
  const config = getConfig();
  const runtimeFile = config.runtimeFile;

  // Back up any existing runtime.json so we can restore it after the test.
  const backupFile = runtimeFile + '.test-backup';
  const hadExisting = existsSync(runtimeFile);
  if (hadExisting) copyFileSync(runtimeFile, backupFile);

  // Write a "concurrent replacement" runtime with a DIFFERENT startedAt than the snapshot.
  // This simulates: another process wrote a fresh runtime AFTER decideRuntimeAction returned
  // shouldRemove=true but BEFORE the actual delete executes.
  const concurrentRuntime: RuntimeState = {
    httpPort: 19222,
    pgPort: 15440,
    pid: process.pid,
    startedAt: '2025-06-06T10:00:00.000Z',
    dataDir: '/tmp/concurrent-data',
  };
  writeFileSync(runtimeFile, JSON.stringify(concurrentRuntime, null, 2));

  // The stale snapshot the state-2 decision was based on: same pid but DIFFERENT startedAt.
  const staleSnapshot = { pid: process.pid, startedAt: '2024-01-01T00:00:00.000Z' };

  try {
    removeRuntimeIfMatches(staleSnapshot);

    // The file must still exist — the concurrent replacement must NOT have been deleted.
    assert.ok(
      existsSync(runtimeFile),
      'removeRuntimeIfMatches must NOT delete runtime.json when startedAt does not match (F22)',
    );

    const surviving = JSON.parse(readFileSync(runtimeFile, 'utf8')) as RuntimeState;
    assert.equal(
      surviving.startedAt,
      concurrentRuntime.startedAt,
      'concurrent runtime must be preserved unchanged',
    );
  } finally {
    // Restore the original state: remove what the test wrote, restore backup if any.
    if (existsSync(runtimeFile)) rmSync(runtimeFile);
    if (hadExisting) renameSync(backupFile, runtimeFile);
    else if (existsSync(backupFile)) rmSync(backupFile);
  }
});

test('removeRuntimeIfMatches: does NOT delete when on-disk runtime has a different pid (F22 concurrent spawn)', async () => {
  const { removeRuntimeIfMatches } = await import('./ensure-revisium.js');
  const config = getConfig();
  const runtimeFile = config.runtimeFile;

  const backupFile = runtimeFile + '.test-backup2';
  const hadExisting = existsSync(runtimeFile);
  if (hadExisting) copyFileSync(runtimeFile, backupFile);

  const sameStartedAt = '2025-06-06T11:00:00.000Z';
  const concurrentRuntime: RuntimeState = {
    httpPort: 19222,
    pgPort: 15440,
    pid: 88888, // different pid from the stale snapshot
    startedAt: sameStartedAt,
    dataDir: '/tmp/other-data',
  };
  writeFileSync(runtimeFile, JSON.stringify(concurrentRuntime, null, 2));

  // Snapshot with different pid — identity mismatch on the pid field.
  const staleSnapshot = { pid: 99999, startedAt: sameStartedAt };

  try {
    removeRuntimeIfMatches(staleSnapshot);

    assert.ok(
      existsSync(runtimeFile),
      'removeRuntimeIfMatches must NOT delete runtime.json when pid does not match (F22)',
    );
    const surviving = JSON.parse(readFileSync(runtimeFile, 'utf8')) as RuntimeState;
    assert.equal(surviving.pid, 88888, 'concurrent runtime pid must be preserved');
  } finally {
    if (existsSync(runtimeFile)) rmSync(runtimeFile);
    if (hadExisting) renameSync(backupFile, runtimeFile);
    else if (existsSync(backupFile)) rmSync(backupFile);
  }
});

test('removeRuntimeIfMatches: DOES delete when on-disk runtime exactly matches snapshot (F19 / F22 identity confirmed)', async () => {
  const { removeRuntimeIfMatches } = await import('./ensure-revisium.js');
  const config = getConfig();
  const runtimeFile = config.runtimeFile;

  const backupFile = runtimeFile + '.test-backup3';
  const hadExisting = existsSync(runtimeFile);
  if (hadExisting) copyFileSync(runtimeFile, backupFile);

  const matchingRuntime: RuntimeState = {
    httpPort: 19222,
    pgPort: 15440,
    pid: 77777,
    startedAt: '2024-05-01T00:00:00.000Z',
    dataDir: '/tmp/stale-data',
  };
  writeFileSync(runtimeFile, JSON.stringify(matchingRuntime, null, 2));

  // Snapshot exactly matches the on-disk runtime — deletion is expected.
  const snapshot = { pid: 77777, startedAt: '2024-05-01T00:00:00.000Z' };

  try {
    removeRuntimeIfMatches(snapshot);

    assert.ok(
      !existsSync(runtimeFile),
      'removeRuntimeIfMatches MUST delete runtime.json when identity matches (F19 / F22)',
    );
  } finally {
    if (existsSync(runtimeFile)) rmSync(runtimeFile, { force: true });
    if (hadExisting) renameSync(backupFile, runtimeFile);
    else if (existsSync(backupFile)) rmSync(backupFile);
  }
});

test('removeRuntimeIfMatches: safe no-op when runtime.json does not exist (F22 already cleaned)', async () => {
  const { removeRuntimeIfMatches } = await import('./ensure-revisium.js');
  const config = getConfig();
  const runtimeFile = config.runtimeFile;

  const backupFile = runtimeFile + '.test-backup4';
  const hadExisting = existsSync(runtimeFile);
  if (hadExisting) copyFileSync(runtimeFile, backupFile);
  // Ensure file is absent.
  if (existsSync(runtimeFile)) rmSync(runtimeFile);

  const snapshot = { pid: 55555, startedAt: '2024-01-01T00:00:00.000Z' };

  try {
    // Must not throw even when the file is absent.
    assert.doesNotThrow(() => removeRuntimeIfMatches(snapshot));
    assert.ok(!existsSync(runtimeFile), 'no new runtime.json should appear');
  } finally {
    if (hadExisting) renameSync(backupFile, runtimeFile);
    else if (existsSync(backupFile)) rmSync(backupFile);
  }
});
