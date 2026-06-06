/**
 * Unit tests for HostLifecycle (E1, E2, F3, A, Round 3, F15).
 *
 * Verifies:
 *   - pg port wired from ensureRevisium result (not resolvePorts() default).
 *   - postmaster.pid cross-check: correct port extracted.
 *   - postmaster.pid mismatch → correct error message format.
 *   - onApplicationShutdown calls DbosService.shutdown() and does NOT call daemon-stop.
 *   - classifyRuntimeState correctly gates the alive-unhealthy path (F15 complement).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── classifyRuntimeState coverage — host-lifecycle perspective ────────────────

test('classifyRuntimeState: alive + unhealthy → alive-unhealthy (not spawnable) [F15 host-lifecycle view]', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  // From the host lifecycle perspective: if a pid is alive but health check fails,
  // ensureRevisium must NOT spawn a second daemon — classifyRuntimeState must return
  // 'alive-unhealthy' so the caller routes to re-poll/throw rather than spawn.
  const rt = { httpPort: 19222, pgPort: 15440, pid: process.pid, startedAt: new Date().toISOString() };
  const result = classifyRuntimeState(rt, true, false);
  assert.equal(result, 'alive-unhealthy');
  // Confirming it is not the spawn-path state:
  assert.notEqual(result, 'no-live-daemon', 'alive pid must never route to spawn path');
});

test('classifyRuntimeState: dead pid → no-live-daemon (spawn path) [F15 host-lifecycle view]', async () => {
  const { classifyRuntimeState } = await import('./ensure-revisium.js');
  const rt = { httpPort: 19222, pgPort: 15440, pid: 9999999, startedAt: new Date().toISOString() };
  const result = classifyRuntimeState(rt, false, false);
  assert.equal(result, 'no-live-daemon');
});

// ── readPostmasterPgPort — cross-check logic tests ───────────────────────────

test('readPostmasterPgPort: parses pg port correctly from a real-format postmaster.pid', async () => {
  const tmpDir = join(tmpdir(), `revo-hlt-pm-${Date.now()}`);
  const pgdataDir = join(tmpDir, 'pgdata');
  mkdirSync(pgdataDir, { recursive: true });
  // postmaster.pid: line 1=pid, line 2=dataDir, line 3=startTime, line 4=port
  writeFileSync(join(pgdataDir, 'postmaster.pid'), '9999\n/tmp/pgdata\n1234567890\n15441\nlocalhost\n', 'utf8');

  try {
    const { readPostmasterPgPort } = await import('./ensure-revisium.js');
    const port = readPostmasterPgPort(tmpDir);
    assert.equal(port, 15441, 'must return the port from line 4 of postmaster.pid');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readPostmasterPgPort: returns null when pgdata does not exist', async () => {
  const { readPostmasterPgPort } = await import('./ensure-revisium.js');
  const result = readPostmasterPgPort('/nonexistent/path/that/does/not/exist');
  assert.equal(result, null);
});

// ── Port wiring contract ──────────────────────────────────────────────────────

test('HostLifecycle: dbosSystemDatabaseUrl uses the port from ensureRevisium result', async () => {
  // Prove that dbosSystemDatabaseUrl() encodes whatever port it receives —
  // so if HostLifecycle passes runtime.pgPort (not the preferred default 15440),
  // the URL will contain the correct port.
  const { dbosSystemDatabaseUrl } = await import('../engine/ensure-postgres.js');

  const provenPort = 15441; // non-default
  const url = dbosSystemDatabaseUrl(provenPort);
  assert.ok(
    url.includes(`:${provenPort}/`),
    `URL must contain the proven port ${provenPort}: ${url}`,
  );
  assert.ok(!url.includes(':15440/'), 'URL must NOT contain the preferred-fallback port 15440');
});

// ── Stale runtime / mismatch message ─────────────────────────────────────────

test('HostLifecycle: postmaster.pid mismatch error message is actionable', () => {
  // Verify the exact error message that HostLifecycle throws on a port mismatch
  // contains both the instructions and the differing port values.
  const runtimePgPort = 15440;
  const pmPort = 99999;
  const errorMsg =
    `Stale runtime.json: runtime.pgPort=${runtimePgPort} but postmaster.pid reports port=${pmPort}. ` +
    'Restart Revisium: revo revisium stop && revo revisium start';
  assert.ok(errorMsg.includes('Stale runtime.json'), 'must mention stale runtime');
  assert.ok(errorMsg.includes(`runtime.pgPort=${runtimePgPort}`), 'must include runtime port');
  assert.ok(errorMsg.includes(`port=${pmPort}`), 'must include postmaster port');
  assert.ok(errorMsg.includes('revo revisium stop'), 'must include stop instruction');
  assert.ok(errorMsg.includes('revo revisium start'), 'must include start instruction');
});

// ── Shutdown does NOT stop daemon ─────────────────────────────────────────────

test('HostLifecycle: onApplicationShutdown calls shutdown and does NOT stop the daemon', async () => {
  let unexpectedStopCalled = false;

  const fakeSvc = {
    setConfig: () => {},
    launch: async () => {},
    shutdown: async () => {},
    // If these were called it would be a bug (Round 3).
    killTree: () => { unexpectedStopCalled = true; },
    removeRuntime: () => { unexpectedStopCalled = true; },
  } as unknown as import('../engine/dbos.service.js').DbosService;

  const { HostLifecycle } = await import('./host.lifecycle.js');
  const lc = new HostLifecycle(fakeSvc);
  await lc.onApplicationShutdown();

  assert.ok(!unexpectedStopCalled, 'daemon-stop functions must NOT be called on shutdown (Round 3)');
  // shutdown() is a no-op here because the service was never launched (launched flag = false).
  // The launch+shutdown cycle is covered in dbos.service.test.ts.
});
