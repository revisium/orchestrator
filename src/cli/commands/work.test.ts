import test from 'node:test';
import assert from 'node:assert/strict';
import { workCommand, makeResolveCwd } from './work.js';
import type { ControlPlaneDataAccess } from '../../control-plane/index.js';
import type { Step } from '../../control-plane/steps.js';

// ─── makeResolveCwd path-traversal guard (B1 contract — delegates to resolve-cwd.ts) ───

const FAKE_STEP: Step = {
  id: 's-1', taskId: 'task-1', runId: 'run-1', role: 'developer', kind: 'implement',
  status: 'claimed', input: null, output: null, modelProfile: 'standard', runAfter: '',
  attemptCount: 0, maxAttempts: 3, priority: 0, leaseOwner: '', leaseExpiresAt: '', deadReason: '',
};

function fakeDA(repoRef: string): ControlPlaneDataAccess {
  return {
    assertReady: async () => {},
    getRow: async (_table, _rowId) => ({ rowId: _rowId, data: { repo_ref: repoRef } }),
    listRows: async () => [],
    createRow: async () => ({ rowId: '', data: {} }),
    updateRow: async () => ({ rowId: '', data: {} }),
    patchRow: async () => ({ rowId: '', data: {} }),
  };
}

test('makeResolveCwd: throws when repo_ref uses .. to escape the workspace', async () => {
  const base = '/workspace/root';
  const resolveCwd = makeResolveCwd(fakeDA('../evil'), base);
  await assert.rejects(
    () => resolveCwd(FAKE_STEP),
    /escapes the workspace base/,
    'path traversal via ../ must be rejected',
  );
});

test('makeResolveCwd: throws when repo_ref is a relative non-existent path under the workspace', async () => {
  // B1 fix: non-existent paths are rejected (existence check added).
  // The old test checked that absolute paths OUTSIDE the workspace are rejected.
  // New behavior: absolute paths ARE accepted (the external target-repo case);
  // but non-existent paths are always rejected regardless of absolute/relative.
  const base = '/workspace/root';
  // '/workspace/root/does-not-exist' does not exist → must throw
  const resolveCwd = makeResolveCwd(fakeDA('does-not-exist'), base);
  await assert.rejects(
    () => resolveCwd(FAKE_STEP),
    /does not exist or is not a directory/,
    'non-existent repo_ref path must be rejected',
  );
});

test('makeResolveCwd: accepts absolute existing dir (the external target-repo case, B1 fix)', async () => {
  // B1 fix: an absolute path to an existing directory is accepted (not rejected as "outside workspace").
  // We use /tmp which always exists.
  const base = '/workspace/root';
  const resolveCwd = makeResolveCwd(fakeDA('/tmp'), base);
  const cwd = await resolveCwd(FAKE_STEP);
  assert.equal(cwd, '/tmp', 'absolute existing directory must be accepted as the target repo');
});

// ─── workCommand ──────────────────────────────────────────────────────────────

test('workCommand: --live without --runner auto → exitCode===1, error message, no runner/daemon invoked', async () => {
  // FIX 1 regression: --live must be rejected when runnerMode is not 'auto'.
  // Guard fires BEFORE runner construction and BEFORE daemon connection.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    // Default runner is 'stub'; passing --live without --runner auto must fail immediately.
    await workCommand({ live: true, once: true });
  } finally {
    console.error = origError;
  }

  try {
    assert.equal(process.exitCode, 1, 'exitCode must be 1 when --live is given without --runner auto');
    assert.ok(
      errors.some((e) => e === 'Error: --live requires --runner auto'),
      `error must be exactly 'Error: --live requires --runner auto'; got: ${JSON.stringify(errors)}`,
    );
    // No daemon connection attempted — no DAEMON_NOT_RUNNING error
    const hasDaemonError = errors.some((e) => e.includes('DAEMON_NOT_RUNNING'));
    assert.equal(hasDaemonError, false, 'guard must exit before any daemon connection attempt');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('workCommand: exits with code 1 and logs an error when --roles produces an empty list', async () => {
  const errors: string[] = [];
  const origConsoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    // ',,,' filters to empty after trim+filter — no role names remain.
    await workCommand({ roles: ',,,', once: true });
  } finally {
    console.error = origConsoleError;
  }

  try {
    assert.equal(process.exitCode, 1, 'exit code must be 1 when roles list is empty');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('roles')),
      'error message must mention roles',
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── live-guard: --runner auto without --live (cost guard) ───────────────────

test('workCommand: default (no --runner) → stub mode, no live-guard error', async () => {
  // Default runner is stub; no guard fires. The function will fail on assertReady (no daemon)
  // but NOT on the live guard. Verify: no requireLiveFlag error message.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await workCommand({ once: true });
  } finally {
    console.error = origError;
  }

  try {
    // The error will be DAEMON_NOT_RUNNING — NOT a live-guard error.
    const hasLiveGuardError = errors.some((e) =>
      e.includes('requires --live') || e.includes('choose either'),
    );
    assert.equal(hasLiveGuardError, false, 'default stub mode must not emit live-guard error');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('workCommand: --runner stub → stub mode, no live-guard error', async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await workCommand({ runner: 'stub', once: true });
  } finally {
    console.error = origError;
  }

  try {
    const hasLiveGuardError = errors.some((e) =>
      e.includes('requires --live') || e.includes('choose either'),
    );
    assert.equal(hasLiveGuardError, false, '--runner stub must not emit live-guard error');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('workCommand: --runner auto WITHOUT --live → exitCode===1, live-guard error, no runner built', async () => {
  // Guard fires BEFORE da.assertReady() (early-exit). No daemon needed.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await workCommand({ runner: 'auto', once: true });
  } finally {
    console.error = origError;
  }

  try {
    assert.equal(process.exitCode, 1, 'exitCode must be 1 when --runner auto is used without --live');
    assert.ok(
      errors.some((e) => e.includes('requires --live')),
      `error must mention --live requirement; got: ${JSON.stringify(errors)}`,
    );
    // No daemon connection attempted — no DAEMON_NOT_RUNNING error
    const hasDaemonError = errors.some((e) => e.includes('DAEMON_NOT_RUNNING'));
    assert.equal(hasDaemonError, false, 'guard must exit before any daemon connection attempt');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('workCommand: --runner auto --live → warning emitted + live path attempted (real runner construction triggered)', async () => {
  // With --runner auto --live: guard passes + warning fires before assertReady.
  // assertReady then throws DAEMON_NOT_RUNNING (no live Revisium in tests).
  // This proves: (a) guard passed, (b) warning fired, (c) live runner path was entered.
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => { warns.push(String(args[0])); };
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  const { LIVE_COST_WARNING } = await import('../live-guard.js');

  try {
    await workCommand({ runner: 'auto', live: true, once: true });
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }

  try {
    // Guard passed — no "requires --live" error
    const hasGuardError = errors.some((e) => e.includes('requires --live'));
    assert.equal(hasGuardError, false, 'guard must NOT fire when --live is provided');

    // Warning was emitted before daemon connection (BEFORE assertReady throws)
    assert.ok(
      warns.some((w) => w === LIVE_COST_WARNING),
      `LIVE_COST_WARNING must be emitted; got warns: ${JSON.stringify(warns)}`,
    );

    // Live path was entered: assertReady threw DAEMON_NOT_RUNNING → exitCode=1
    assert.equal(process.exitCode, 1, 'exitCode must be 1 (from DAEMON_NOT_RUNNING, not guard)');
    const hasDaemonError = errors.some(
      (e) => e.includes('DAEMON_NOT_RUNNING') || e.includes('revisium start'),
    );
    assert.ok(hasDaemonError, `live path must have attempted assertReady; errors: ${JSON.stringify(errors)}`);
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});
