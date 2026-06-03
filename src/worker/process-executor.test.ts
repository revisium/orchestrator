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
