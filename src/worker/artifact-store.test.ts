import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from './artifact-store.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'revo-artifacts-'));
}

test('artifact store: writes redacted stdout/stderr files, metadata, events, and capped tails', () => {
  const root = tempRoot();
  try {
    const store = createArtifactStore(root, { tailBytes: 8 });
    const writer = store.startProcess({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stepId: 'step-1',
      role: 'developer',
      runner: 'claude-code',
      command: 'claude',
      args: ['-p'],
      cwd: '/workspace/repo',
      timeoutMs: 123,
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    writer.appendStdout('hello gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345');
    writer.appendStderr('stderr-1234567890');
    const snapshot = writer.finish({
      code: 0,
      timedOut: false,
      finishedAt: new Date('2026-01-01T00:00:01.000Z'),
    });

    assert.equal(snapshot.ref, 'run-1/attempt-1');
    assert.equal(snapshot.stdoutTail.includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false);
    assert.equal(snapshot.stdoutTail.length <= 8, true);
    assert.equal(snapshot.stderrTail, '34567890');

    const stdout = readFileSync(writer.ref.stdoutPath, 'utf8');
    const stderr = readFileSync(writer.ref.stderrPath, 'utf8');
    const meta = JSON.parse(readFileSync(writer.ref.metaPath, 'utf8')) as Record<string, unknown>;
    const events = readFileSync(writer.ref.eventsPath, 'utf8').trim().split('\n');

    assert.equal(stdout.includes('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false);
    assert.equal(stderr, 'stderr-1234567890');
    assert.equal(meta.status, 'finished');
    assert.equal(meta.code, 0);
    assert.equal(meta.ref, 'run-1/attempt-1');
    assert.equal(events.length, 2);
    assert.match(events[0] ?? '', /process_started/);
    assert.match(events[1] ?? '', /process_finished/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact store: rejects unsafe path segments', () => {
  const root = tempRoot();
  try {
    const store = createArtifactStore(root);
    assert.throws(
      () =>
        store.startProcess({
          runId: '../run',
          attemptId: 'attempt-1',
          stepId: 'step-1',
          role: 'developer',
          runner: 'claude-code',
          command: 'claude',
          args: [],
          cwd: '/workspace/repo',
          timeoutMs: 123,
        }),
      /invalid runId/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact store: runner is written to meta.json on running and finished states', () => {
  const root = tempRoot();
  try {
    const store = createArtifactStore(root);
    const writer = store.startProcess({
      runId: 'run-r',
      attemptId: 'attempt-r',
      stepId: 'step-r',
      role: 'developer',
      runner: 'codex',
      command: 'codex',
      args: [],
      cwd: '/workspace/repo',
      timeoutMs: 60000,
    });

    const runningMeta = JSON.parse(readFileSync(writer.ref.metaPath, 'utf8')) as Record<string, unknown>;
    assert.equal(runningMeta.runner, 'codex', 'runner should be present in running meta.json');
    assert.equal(runningMeta.status, 'running');

    writer.finish({ code: 0 });
    const finishedMeta = JSON.parse(readFileSync(writer.ref.metaPath, 'utf8')) as Record<string, unknown>;
    assert.equal(finishedMeta.runner, 'codex', 'runner should be present in finished meta.json');
    assert.equal(finishedMeta.status, 'finished');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
