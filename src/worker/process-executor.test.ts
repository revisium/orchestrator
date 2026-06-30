import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RUNNER_IDLE_TIMEOUT_KIND,
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  resolveEffectiveRunnerTimeoutPolicy,
  resolveRunnerTimeoutPolicy,
  spawnExecutor,
} from './process-executor.js';

// These tests run trivial cross-platform commands through the REAL spawnExecutor.
// No `claude`, no tokens — just node subprocesses, to prove the spawn boundary works.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('spawnExecutor: captures stdout and exit code 0', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', "process.stdout.write('hi')"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });

  assert.equal(result.stdout, 'hi');
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
});

test('spawnExecutor: captures a non-zero exit code without rejecting', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    cwd: process.cwd(),
    timeoutMs: 10_000,
  });

  assert.equal(result.code, 3);
  assert.equal(result.timedOut, false);
});

test('spawnExecutor: pipes input on stdin', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: [
      '-e',
      "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.toUpperCase()))",
    ],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    input: 'abc',
  });

  assert.equal(result.stdout, 'ABC');
  assert.equal(result.code, 0);
});

test('spawnExecutor: reports pid and stdout/stderr chunks to callbacks', async () => {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let pid = 0;

  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', "process.stdout.write('out');process.stderr.write('err')"],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    onSpawn: (childPid) => { pid = childPid; },
    onStdoutChunk: (chunk) => { stdoutChunks.push(chunk); },
    onStderrChunk: (chunk) => { stderrChunks.push(chunk); },
  });

  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.ok(pid > 0, 'spawn callback receives the child pid');
  assert.equal(stdoutChunks.join(''), 'out');
  assert.equal(stderrChunks.join(''), 'err');
});

test('spawnExecutor: onSpawn failure kills the spawned child before rejecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-spawn-setup-'));
  const markerPath = join(root, 'leaked-child');
  let pid = 0;
  try {
    await assert.rejects(
      () =>
        spawnExecutor({
          command: process.execPath,
          args: [
            '-e',
            [
              "const fs = require('node:fs')",
              `setTimeout(() => fs.writeFileSync(${JSON.stringify(markerPath)}, 'alive'), 250)`,
              'setTimeout(() => {}, 10000)',
            ].join(';'),
          ],
          cwd: process.cwd(),
          timeoutMs: 10_000,
          idleTimeoutMs: 10_000,
          onSpawn: (childPid) => {
            pid = childPid;
            throw new Error('spawn observer failed');
          },
        }),
      /spawn observer failed/,
    );

    assert.ok(pid > 0, 'onSpawn receives the child pid before failing');
    await sleep(500);
    assert.equal(existsSync(markerPath), false, 'child should be killed before it can keep running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawnExecutor: stdout and stderr activity reset the idle deadline', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: [
      '-e',
      [
        "process.stdout.write('out1')",
        "setTimeout(()=>process.stderr.write('err1'), 1500)",
        "setTimeout(()=>process.stdout.write('out2'), 3000)",
        'setTimeout(()=>process.exit(0), 3800)',
      ].join(';'),
    ],
    cwd: process.cwd(),
    timeoutMs: 6_000,
    idleTimeoutMs: 2_000,
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'out1out2');
  assert.equal(result.stderr, 'err1');
});

test('spawnExecutor: kills a silent process that exceeds idleTimeoutMs', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    idleTimeoutMs: 100,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, RUNNER_IDLE_TIMEOUT_KIND);
  assert.equal(result.timeoutEvidence?.idleTimeoutMs, 100);
  assert.equal(result.timeoutEvidence?.wallClockLimitMs, 1_000);
  assert.ok((result.timeoutEvidence?.idleMs ?? 0) >= 90);
  // Killed by signal → no exit code.
  assert.equal(result.code, null);
});

test('spawnExecutor: in-flight operation suppresses idle timeout', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 220)'],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    idleTimeoutMs: 80,
    onActivityTracker: (activity) => {
      activity.operationStarted('tool-1');
    },
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
});

test('spawnExecutor: wall-clock cap kills despite activity and in-flight operations', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', "process.stdout.write('x');setInterval(()=>process.stdout.write('x'), 100);setTimeout(() => {}, 10000)"],
    cwd: process.cwd(),
    timeoutMs: 1_000,
    idleTimeoutMs: 70,
    onActivityTracker: (activity) => {
      activity.operationStarted('tool-1');
    },
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutKind, RUNNER_WALL_CLOCK_LIMIT_KIND);
  assert.equal(result.timeoutEvidence?.wallClockLimitMs, 1_000);
  assert.equal(result.timeoutEvidence?.inFlightOperationCount, 1);
  assert.ok((result.timeoutEvidence?.stdoutBytes ?? 0) > 0);
  assert.equal(result.code, null);
});

test('resolveRunnerTimeoutPolicy accepts positive env overrides and fails loud on invalid values', () => {
  assert.deepEqual(
    resolveRunnerTimeoutPolicy({
      env: {
        REVO_RUNNER_IDLE_TIMEOUT_MS: '123',
        REVO_RUNNER_WALL_CLOCK_LIMIT_MS: '456',
      },
    }),
    { idleTimeoutMs: 123, wallClockLimitMs: 456 },
  );

  assert.throws(
    () => resolveRunnerTimeoutPolicy({ env: { REVO_RUNNER_IDLE_TIMEOUT_MS: 'abc' } }),
    /REVO_RUNNER_IDLE_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => resolveRunnerTimeoutPolicy({ env: { REVO_RUNNER_WALL_CLOCK_LIMIT_MS: '0' } }),
    /REVO_RUNNER_WALL_CLOCK_LIMIT_MS must be a positive integer/,
  );
});

test('resolveEffectiveRunnerTimeoutPolicy lets env override role and default wall-clock caps', () => {
  assert.deepEqual(
    resolveEffectiveRunnerTimeoutPolicy({
      idleTimeoutMs: 111,
      wallClockLimitMs: 222,
      roleTimeoutMs: 333,
      env: { REVO_RUNNER_WALL_CLOCK_LIMIT_MS: '444' },
    }),
    { idleTimeoutMs: 111, wallClockLimitMs: 444 },
  );

  assert.deepEqual(
    resolveEffectiveRunnerTimeoutPolicy({
      idleTimeoutMs: 111,
      wallClockLimitMs: 222,
      roleTimeoutMs: 333,
      env: {},
    }),
    { idleTimeoutMs: 111, wallClockLimitMs: 333 },
  );

  assert.deepEqual(
    resolveEffectiveRunnerTimeoutPolicy({
      idleTimeoutMs: 111,
      wallClockLimitMs: 222,
      roleTimeoutMs: 0,
      env: {},
    }),
    { idleTimeoutMs: 111, wallClockLimitMs: 222 },
  );
});

test('spawnExecutor: merges caller env with process.env (does not replace it)', async () => {
  const sentinelKey = 'REVO_TEST_SENTINEL_KEY';
  const sentinelValue = 'sentinel123';
  const callerEnv = { [sentinelKey]: sentinelValue };

  const result = await spawnExecutor({
    command: process.execPath,
    args: [
      '-e',
      // Write BOTH the caller-supplied key and a well-known key from process.env (PATH).
      // If env was replaced instead of merged, PATH would be absent.
      `process.stdout.write(JSON.stringify({ caller: process.env['${sentinelKey}'], path: typeof process.env['PATH'] }))`,
    ],
    cwd: process.cwd(),
    timeoutMs: 10_000,
    env: callerEnv,
  });

  assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout) as { caller: string; path: string };
  assert.equal(out.caller, sentinelValue, 'caller-supplied env key must be present');
  assert.equal(out.path, 'string', 'PATH from process.env must still be present after merge');
});

test('spawnExecutor: rejects when the binary is missing', async () => {
  await assert.rejects(
    () =>
      spawnExecutor({
        command: 'definitely-not-a-real-binary-xyz',
        args: [],
        cwd: process.cwd(),
        timeoutMs: 10_000,
      }),
    'spawn-level error must reject so the runner can map it to a lesson',
  );
});
