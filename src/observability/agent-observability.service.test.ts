import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentObservabilityError, AgentObservabilityService } from './index.js';

const GH_TOKEN = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'revo-observability-'));
}

function writeAttempt(
  root: string,
  input: {
    runId?: string;
    attemptId?: string;
    meta?: Record<string, unknown>;
    stdout?: string;
    stderr?: string;
    events?: string;
  } = {},
): string {
  const runId = input.runId ?? 'run-1';
  const attemptId = input.attemptId ?? 'attempt-1';
  const dir = join(root, runId, attemptId);
  mkdirSync(dir, { recursive: true });
  if (input.meta !== undefined) writeFileSync(join(dir, 'meta.json'), JSON.stringify(input.meta, null, 2), 'utf8');
  if (input.stdout !== undefined) writeFileSync(join(dir, 'stdout.log'), input.stdout, 'utf8');
  if (input.stderr !== undefined) writeFileSync(join(dir, 'stderr.log'), input.stderr, 'utf8');
  if (input.events !== undefined) writeFileSync(join(dir, 'events.jsonl'), input.events, 'utf8');
  return dir;
}

function assertObsError(error: unknown, code: string): void {
  assert.ok(error instanceof AgentObservabilityError);
  assert.equal(error.code, code);
}

test('agent observability: rejects traversal input before file access', async () => {
  const root = tempRoot();
  try {
    const service = new AgentObservabilityService({ artifactRoot: root });

    await assert.rejects(() => service.listAgentAttempts('../run'), (error) => {
      assertObsError(error, 'VALIDATION_FAILURE');
      return true;
    });
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: '/attempt-1', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: 'attempt\\1', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1\0', attemptId: 'attempt-1', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: '', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: rejects symlink attempts without following escape paths', async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    mkdirSync(join(root, 'run-1'), { recursive: true });
    writeAttempt(outside, { runId: 'external', attemptId: 'attempt-1', stdout: 'secret outside' });
    symlinkSync(join(outside, 'external', 'attempt-1'), join(root, 'run-1', 'attempt-1'));
    const service = new AgentObservabilityService({ artifactRoot: root });

    await assert.rejects(() => service.listAgentAttempts('run-1'), (error) => {
      assertObsError(error, 'VALIDATION_FAILURE');
      return true;
    });
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('agent observability: distinguishes missing run and existing run with no attempts through runExists', async () => {
  const root = tempRoot();
  try {
    const missing = new AgentObservabilityService({ artifactRoot: root, runExists: () => false });
    await assert.rejects(() => missing.listAgentAttempts('run-missing'), (error) => {
      assertObsError(error, 'RUN_NOT_FOUND');
      return true;
    });

    const empty = new AgentObservabilityService({ artifactRoot: root, runExists: () => true });
    assert.deepEqual(await empty.listAgentAttempts('run-empty'), []);
    await assert.rejects(() => empty.getAgentLog({ runId: 'run-empty', stream: 'stdout' }), (error) => {
      assertObsError(error, 'NO_AGENT_ATTEMPT_AVAILABLE');
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: maps partial metadata and byte counts without exposing private fields', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      meta: {
        runId: 'ignored',
        attemptId: 'ignored',
        stepId: 'step-1',
        role: 'developer',
        startedAt: '2026-06-01T00:00:00.000Z',
        status: 'finished',
        code: 0,
        command: 'claude',
        cwd: '/Users/anton/projects/revisium/agent-orchestrator',
      },
      stdout: 'hello',
      stderr: 'ошибка',
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const attempts = await service.listAgentAttempts('run-1');
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0], {
      runId: 'run-1',
      attemptId: 'attempt-1',
      stepId: 'step-1',
      role: 'developer',
      runner: 'unknown',
      artifactRef: 'run-1/attempt-1',
      startedAt: '2026-06-01T00:00:00.000Z',
      status: 'finished',
      exitCode: 0,
      stdoutBytes: Buffer.byteLength('hello'),
      stderrBytes: Buffer.byteLength('ошибка'),
    });
    assert.equal(JSON.stringify(attempts).includes('/Users/anton'), false);
    assert.equal(JSON.stringify(attempts).includes('claude'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: oversized metadata is rejected while bounded log reads still work', async () => {
  const root = tempRoot();
  try {
    const attemptDir = writeAttempt(root, {
      meta: { stepId: 'step-1', role: 'developer', startedAt: '2026-06-01T00:00:00.000Z' },
      stdout: 'visible log',
    });
    writeFileSync(join(attemptDir, 'meta.json'), `{"padding":"${'x'.repeat(70_000)}"}`, 'utf8');
    const service = new AgentObservabilityService({ artifactRoot: root });

    await assert.rejects(() => service.listAgentAttempts('run-1'), (error) => {
      assertObsError(error, 'VALIDATION_FAILURE');
      return true;
    });

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes: 0,
      limitBytes: 7,
    });
    assert.equal(chunk.content, 'visible');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: default tail and explicit offset/limit use byte ranges', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      stdout: '0123456789',
      meta: { stepId: 'step-1', role: 'developer', runner: 'script', startedAt: '2026-06-01T00:00:00.000Z' },
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const tail = await service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stdout', tailBytes: 4 });
    assert.equal(tail.offsetBytes, 6);
    assert.equal(tail.nextOffsetBytes, 10);
    assert.equal(tail.totalBytes, 10);
    assert.equal(tail.truncated, true);
    assert.equal(tail.content, '6789');

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes: 2,
      limitBytes: 5,
    });
    assert.equal(chunk.offsetBytes, 2);
    assert.equal(chunk.nextOffsetBytes, 7);
    assert.equal(chunk.truncated, true);
    assert.equal(chunk.content, '23456');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: offset past EOF returns an empty chunk at EOF', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, { stdout: 'abc' });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes: 10,
      limitBytes: 5,
    });

    assert.equal(chunk.offsetBytes, 3);
    assert.equal(chunk.nextOffsetBytes, 3);
    assert.equal(chunk.totalBytes, 3);
    assert.equal(chunk.truncated, false);
    assert.equal(chunk.content, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: validates negative offsets, oversized limits, and conflicting args', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, { stdout: 'abc' });
    const service = new AgentObservabilityService({ artifactRoot: root });

    for (const input of [
      { offsetBytes: -1, limitBytes: 1 },
      { offsetBytes: 0, limitBytes: 1_048_577 },
      { offsetBytes: 0, limitBytes: 0 },
      { offsetBytes: 0, tailBytes: 1 },
    ]) {
      await assert.rejects(
        () => service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stdout', ...input }),
        (error) => {
          assertObsError(error, 'VALIDATION_FAILURE');
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: missing log file for an existing attempt returns an empty chunk', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, { meta: { stepId: 'step-1', role: 'developer', startedAt: '2026-06-01T00:00:00.000Z' } });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const chunk = await service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stderr' });

    assert.deepEqual(chunk, {
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stderr',
      offsetBytes: 0,
      totalBytes: 0,
      truncated: false,
      content: '',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: aligns UTF-8 chunks so emoji and Cyrillic are not malformed', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, { stdout: 'A😀Б' });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const emoji = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes: 2,
      limitBytes: 2,
    });
    assert.equal(emoji.offsetBytes, 5);
    assert.equal(emoji.nextOffsetBytes, 5);
    assert.equal(emoji.content, '');
    assert.equal(emoji.content.includes('\uFFFD'), false);

    const cyrillic = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes: 5,
      limitBytes: 2,
    });
    assert.equal(cyrillic.offsetBytes, 5);
    assert.equal(cyrillic.nextOffsetBytes, 7);
    assert.equal(cyrillic.content, 'Б');
    assert.equal(cyrillic.content.includes('\uFFFD'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: combined stream is deterministic and bounded over synthetic content', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      stdout: 'out',
      stderr: 'err',
      meta: { startedAt: '2026-06-01T00:00:00.000Z' },
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const all = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'combined',
      offsetBytes: 0,
      limitBytes: 1_000,
    });
    assert.equal(all.content, '--- stdout ---\nout\n--- stderr ---\nerr');
    assert.equal(all.totalBytes, Buffer.byteLength(all.content));
    assert.equal(all.truncated, false);

    const bounded = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'combined',
      offsetBytes: Buffer.byteLength('--- stdout ---\n'),
      limitBytes: 3,
    });
    assert.equal(bounded.content, 'out');
    assert.equal(bounded.truncated, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: redacts GitHub tokens and obvious absolute paths from public content and metadata', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      meta: {
        stepId: `step ${GH_TOKEN}`,
        role: '/Users/anton/projects/revisium/agent-orchestrator',
        runner: 'script',
        startedAt: '2026-06-01T00:00:00.000Z',
      },
      stdout: `token ${GH_TOKEN} path /Users/anton/projects/revisium/agent-orchestrator/src/index.ts`,
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const attempts = await service.listAgentAttempts('run-1');
    const summaryJson = JSON.stringify(attempts);
    assert.equal(summaryJson.includes(GH_TOKEN), false);
    assert.equal(summaryJson.includes('/Users/anton'), false);
    assert.ok(summaryJson.includes('[REDACTED]'));
    assert.ok(summaryJson.includes('[REDACTED_PATH]'));

    const chunk = await service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stdout' });
    assert.equal(chunk.content.includes(GH_TOKEN), false);
    assert.equal(chunk.content.includes('/Users/anton'), false);
    assert.ok(chunk.content.includes('[REDACTED]'));
    assert.ok(chunk.content.includes('[REDACTED_PATH]'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: split token chunks never expose raw token fragments', async () => {
  const root = tempRoot();
  try {
    const content = `prefix ${GH_TOKEN} suffix`;
    writeAttempt(root, { stdout: content });
    const service = new AgentObservabilityService({ artifactRoot: root });
    const tokenStart = Buffer.byteLength('prefix ', 'utf8');

    for (const [offsetBytes, limitBytes] of [
      [tokenStart, 4],
      [tokenStart + 4, 10],
      [tokenStart + 12, 12],
    ] as const) {
      const chunk = await service.getAgentLog({
        runId: 'run-1',
        attemptId: 'attempt-1',
        stream: 'stdout',
        offsetBytes,
        limitBytes,
      });

      assert.equal(chunk.offsetBytes, offsetBytes);
      assert.equal(chunk.nextOffsetBytes, offsetBytes + limitBytes);
      assert.equal(chunk.content.includes('gho_'), false);
      assert.equal(chunk.content.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), false);
      assert.equal(chunk.content.includes('012345'), false);
      assert.ok(chunk.content.includes('[REDACTED]'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: split absolute path chunks never expose raw path fragments', async () => {
  const root = tempRoot();
  try {
    const path = '/Users/anton/projects/revisium/agent-orchestrator/src/index.ts';
    const content = `prefix ${path} suffix`;
    writeAttempt(root, { stdout: content });
    const service = new AgentObservabilityService({ artifactRoot: root });
    const pathStart = Buffer.byteLength('prefix ', 'utf8');

    for (const [offsetBytes, limitBytes] of [
      [pathStart, 12],
      [pathStart + 1, 11],
      [pathStart + 7, 20],
    ] as const) {
      const chunk = await service.getAgentLog({
        runId: 'run-1',
        attemptId: 'attempt-1',
        stream: 'stdout',
        offsetBytes,
        limitBytes,
      });

      assert.equal(chunk.offsetBytes, offsetBytes);
      assert.equal(chunk.nextOffsetBytes, offsetBytes + limitBytes);
      assert.equal(chunk.content.includes('/Users/anton'), false);
      assert.equal(chunk.content.includes('Users/anton'), false);
      assert.equal(chunk.content.includes('projects/revisium'), false);
      assert.ok(chunk.content.includes('[REDACTED_PATH]'));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: tiny chunks in a long token-shaped span are conservatively redacted', async () => {
  const root = tempRoot();
  try {
    const longToken = `gho_${'A'.repeat(160_000)}`;
    const prefix = 'prefix ';
    writeAttempt(root, { stdout: `${prefix}${longToken} suffix` });
    const service = new AgentObservabilityService({ artifactRoot: root });
    const offsetBytes = Buffer.byteLength(prefix, 'utf8') + 80_000;

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes,
      limitBytes: 1,
    });

    assert.equal(chunk.offsetBytes, offsetBytes);
    assert.equal(chunk.nextOffsetBytes, offsetBytes + 1);
    assert.equal(chunk.content, '[REDACTED]');
    assert.equal(chunk.content.includes('AAAA'), false);
    assert.equal(chunk.content.includes('gho_'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: tiny chunks in a long absolute path are conservatively redacted', async () => {
  const root = tempRoot();
  try {
    const longPath = `/Users/anton/projects/${'a'.repeat(160_000)}/file.txt`;
    const prefix = 'prefix ';
    writeAttempt(root, { stdout: `${prefix}${longPath} suffix` });
    const service = new AgentObservabilityService({ artifactRoot: root });
    const offsetBytes = Buffer.byteLength(`${prefix}/Users/anton/projects/`, 'utf8') + 80_000;

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes,
      limitBytes: 1,
    });

    assert.equal(chunk.offsetBytes, offsetBytes);
    assert.equal(chunk.nextOffsetBytes, offsetBytes + 1);
    assert.equal(chunk.content, '[REDACTED]');
    assert.equal(chunk.content.includes('a'), false);
    assert.equal(chunk.content.includes('/Users/anton'), false);
    assert.equal(chunk.content.includes('projects'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: expanded windows align before decoding when starting inside an emoji', async () => {
  const root = tempRoot();
  try {
    const filler = 'y'.repeat(65_536);
    const prefix = `x😀${filler} `;
    writeAttempt(root, { stdout: `${prefix}OK` });
    const service = new AgentObservabilityService({ artifactRoot: root });
    const offsetBytes = Buffer.byteLength(prefix, 'utf8');

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'stdout',
      offsetBytes,
      limitBytes: 2,
    });

    assert.equal(chunk.offsetBytes, offsetBytes);
    assert.equal(chunk.nextOffsetBytes, offsetBytes + 2);
    assert.equal(chunk.content, 'OK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: rejects pre-existing symlink log files', async () => {
  const root = tempRoot();
  const outside = tempRoot();
  try {
    const attemptDir = writeAttempt(root, { meta: { startedAt: '2026-06-01T00:00:00.000Z' } });
    writeFileSync(join(outside, 'stdout.log'), 'outside stdout', 'utf8');
    writeFileSync(join(outside, 'events.jsonl'), '{"outside":true}\n', 'utf8');
    symlinkSync(join(outside, 'stdout.log'), join(attemptDir, 'stdout.log'));
    symlinkSync(join(outside, 'events.jsonl'), join(attemptDir, 'events.jsonl'));
    const service = new AgentObservabilityService({ artifactRoot: root });

    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: 'attempt-1', stream: 'events' }),
      (error) => {
        assertObsError(error, 'VALIDATION_FAILURE');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('agent observability: latest log selection uses finishedAt or startedAt with deterministic id tie-break', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      attemptId: 'attempt-a',
      meta: { startedAt: '2026-06-01T00:00:00.000Z', finishedAt: '2026-06-01T00:00:10.000Z' },
      stdout: 'old finished',
    });
    writeAttempt(root, {
      attemptId: 'attempt-b',
      meta: { startedAt: '2026-06-01T00:00:20.000Z' },
      stdout: 'new started',
    });
    writeAttempt(root, {
      attemptId: 'attempt-c',
      meta: { startedAt: '2026-06-01T00:00:05.000Z', finishedAt: '2026-06-01T00:00:30.000Z' },
      stdout: 'new finished',
    });
    writeAttempt(root, {
      attemptId: 'tie-a',
      meta: { startedAt: '2026-06-01T00:00:30.000Z' },
      stdout: 'tie a',
    });
    writeAttempt(root, {
      attemptId: 'tie-b',
      meta: { startedAt: '2026-06-01T00:00:30.000Z' },
      stdout: 'tie b',
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const latest = await service.getAgentLog({ runId: 'run-1', stream: 'stdout' });

    assert.equal(latest.attemptId, 'tie-b');
    assert.equal(latest.content, 'tie b');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: events stream reads bounded content', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      events: '{"type":"start"}\n{"type":"finish"}\n',
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const chunk = await service.getAgentLog({
      runId: 'run-1',
      attemptId: 'attempt-1',
      stream: 'events',
      offsetBytes: 0,
      limitBytes: Buffer.byteLength('{"type":"start"}\n', 'utf8'),
    });

    assert.equal(chunk.content, '{"type":"start"}\n');
    assert.equal(chunk.truncated, true);
    assert.equal(chunk.totalBytes, Buffer.byteLength('{"type":"start"}\n{"type":"finish"}\n', 'utf8'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: explicit missing attempt returns no-attempt error', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, { stdout: 'present' });
    const service = new AgentObservabilityService({ artifactRoot: root });

    await assert.rejects(
      () => service.getAgentLog({ runId: 'run-1', attemptId: 'missing-attempt', stream: 'stdout' }),
      (error) => {
        assertObsError(error, 'NO_AGENT_ATTEMPT_AVAILABLE');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
