import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnExecutor } from './process-executor.js';

// These tests run trivial cross-platform commands through the REAL spawnExecutor.
// No `claude`, no tokens — just node subprocesses, to prove the spawn boundary works.

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

test('spawnExecutor: kills a process that exceeds timeoutMs', async () => {
  const result = await spawnExecutor({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 10000)'],
    cwd: process.cwd(),
    timeoutMs: 200,
  });

  assert.equal(result.timedOut, true);
  // Killed by signal → no exit code.
  assert.equal(result.code, null);
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
