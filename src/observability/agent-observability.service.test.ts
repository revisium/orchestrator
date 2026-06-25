import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentObservabilityError, AgentObservabilityService } from './index.js';
import type { AgentOutputEvent } from './types.js';

type WatchAgentOutputArg = Parameters<AgentObservabilityService['watchAgentOutput']>[0];
const watchInputShapeOk: WatchAgentOutputArg = { runId: 'run-typecheck', cursor: 'agent-output-v1:cursor' };
// @ts-expect-error watch input is intentionally protocol-neutral and does not accept bounded-pull options.
const watchInputShapeRejectsLimit: WatchAgentOutputArg = { runId: 'run-typecheck', limit: 1 };
void watchInputShapeOk;
void watchInputShapeRejectsLimit;

const GH_TOKEN = 'gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

function manualGenerator<T>(input: {
  next: () => Promise<IteratorResult<T, void>>;
  return?: () => Promise<IteratorResult<T, void>>;
}): AsyncGenerator<T, void, unknown> {
  return {
    next: input.next,
    return: input.return ?? (async () => ({ done: true, value: undefined })),
    throw: async (error?: unknown) => {
      throw error;
    },
    [Symbol.asyncDispose]: async () => {
      await input.return?.();
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

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
    await assert.rejects(() => missing.getAgentActivity('run-missing'), (error) => {
      assertObsError(error, 'RUN_NOT_FOUND');
      return true;
    });

    const empty = new AgentObservabilityService({ artifactRoot: root, runExists: () => true });
    assert.equal(await empty.getAgentActivity('run-empty'), null);
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

test('agent observability: bounded DBOS stream reads apply cursor and limit without touching files', async () => {
  const events: AgentOutputEvent[] = [
    {
      cursor: 'c1',
      runId: 'run-stream',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'output',
    },
    {
      cursor: 'c2',
      runId: 'run-stream',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'output',
    },
    {
      cursor: 'c3',
      runId: 'run-stream',
      attemptId: 'attempt_2',
      stepId: 'step-2',
      at: '2026-01-01T00:00:02.000Z',
      kind: 'status',
    },
  ];
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    now: () => Date.parse('2026-01-01T00:00:03.500Z'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });

  const page = await service.readAgentOutputEvents({ runId: 'run-stream', cursor: 'c1', limit: 1 });

  assert.deepEqual(page.events.map((event) => event.cursor), ['c2']);
  assert.equal(page.nextCursor, 'c2');
});

test('agent observability: readAgentOutputEvents checks run existence before DBOS stream or no-DBOS handling', async () => {
  let streamRead = false;
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => false,
    dbos: {
      getEvent: async () => null,
      readStream<T>() {
        streamRead = true;
        return (async function* () {
          yield {
            cursor: 'stale',
            runId: 'run-missing',
            attemptId: 'attempt_1',
            stepId: 'step-1',
            at: '2026-01-01T00:00:00.000Z',
            kind: 'output',
          } as T;
        })();
      },
    },
  });
  const noDbos = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => false,
  });

  await assert.rejects(() => service.readAgentOutputEvents({ runId: 'run-missing' }), (error) => {
    assertObsError(error, 'RUN_NOT_FOUND');
    return true;
  });
  await assert.rejects(() => noDbos.readAgentOutputEvents({ runId: 'run-missing' }), (error) => {
    assertObsError(error, 'RUN_NOT_FOUND');
    return true;
  });
  assert.equal(streamRead, false);
});

test('agent observability: readAgentOutputEvents returns redacted whitelisted output events', async () => {
  const events = [
    {
      cursor: 'agent-output-v1:attempt_1:output:stdout:0:1',
      runId: 'run-redact',
      attemptId: 'attempt_1',
      attemptSeq: 1,
      stepId: '/Users/anton/private-step',
      stepKey: '/tmp/private-key',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'output',
      stream: 'agent-jsonl',
      bytes: 8,
      outputOffsetBytes: 0,
      preview: `token ${GH_TOKEN} from /Users/anton/projects/revisium`,
      parsedType: '/home/anton/private-type',
      artifactRef: '/Users/anton/top-level-artifact',
      metadata: { token: GH_TOKEN },
      snapshot: {
        runId: 'run-redact',
        attemptId: 'attempt_1',
        stepId: '/private/tmp/snapshot-step',
        stepKey: '/Volumes/secrets/snapshot-key',
        role: 'developer',
        runner: 'claude-code',
        pid: 123,
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastEventAt: '2026-01-01T00:00:01.000Z',
        lastStream: 'agent_jsonl',
        stdoutBytes: 8,
        stderrBytes: 1,
        eventCount: 2,
        artifactRef: '/Users/anton/run-redact/attempt_1',
        error: `failed at /Users/anton/secret with ${GH_TOKEN}`,
        metadata: { cwd: '/Users/anton/secret' },
      },
    },
  ];
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => true,
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });

  const page = await service.readAgentOutputEvents({ runId: 'run-redact', limit: 1 });

  const event = page.events[0];
  assert.equal(event?.stream, 'agent-jsonl');
  assert.equal(event?.stepId, '[REDACTED_PATH]');
  assert.equal(event?.stepKey, '[REDACTED_PATH]');
  assert.equal(event?.preview?.includes('/Users/anton'), false);
  assert.equal(event?.preview?.includes(GH_TOKEN), false);
  assert.equal(event?.parsedType, '[REDACTED_PATH]');
  assert.equal(event?.snapshot?.stepId, '[REDACTED_PATH]');
  assert.equal(event?.snapshot?.stepKey, '[REDACTED_PATH]');
  assert.equal(event?.snapshot?.artifactRef, '[REDACTED_PATH]');
  assert.equal(event?.snapshot?.error?.includes('/Users/anton'), false);
  assert.equal(event?.snapshot?.error?.includes(GH_TOKEN), false);
  assert.equal(event?.snapshot?.lastStream, undefined);
  const serialized = JSON.stringify(page);
  assert.equal(serialized.includes('agent_jsonl'), false);
  assert.equal(serialized.includes('metadata'), false);
  assert.equal(serialized.includes('top-level-artifact'), false);
});

test('agent observability: readAgentOutputEvents awaits generator cleanup after timeout', async () => {
  let cleanupStarted = false;
  let cleanupFinished = false;
  const generator = manualGenerator<AgentOutputEvent>({
    next: () => new Promise<IteratorResult<AgentOutputEvent, void>>(() => undefined),
    return: async () => {
      cleanupStarted = true;
      await Promise.resolve();
      cleanupFinished = true;
      return { done: true, value: undefined };
    },
  });
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => true,
    dbos: {
      getEvent: async () => null,
      readStream: <T>() => generator as unknown as AsyncGenerator<T, void, unknown>,
    },
  });

  const page = await service.readAgentOutputEvents({ runId: 'run-timeout', timeoutMs: 1 });

  assert.deepEqual(page.events, []);
  assert.equal(cleanupStarted, true);
  assert.equal(cleanupFinished, true);
});

test('agent observability: readAgentOutputEvents awaits generator cleanup after stream failure', async () => {
  const streamError = new Error('stream failed');
  let cleanupFinished = false;
  const generator = manualGenerator<AgentOutputEvent>({
    next: async () => {
      throw streamError;
    },
    return: async () => {
      await Promise.resolve();
      cleanupFinished = true;
      return { done: true, value: undefined };
    },
  });
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => true,
    dbos: {
      getEvent: async () => null,
      readStream: <T>() => generator as unknown as AsyncGenerator<T, void, unknown>,
    },
  });

  await assert.rejects(() => service.readAgentOutputEvents({ runId: 'run-failure' }), streamError);
  assert.equal(cleanupFinished, true);
});

test('agent observability: getAgentActivity derives multi-attempt state from stream snapshots', async () => {
  const events: AgentOutputEvent[] = [
    {
      cursor: 'a1',
      runId: 'run-activity',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      stepKey: 'developer',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'status',
      statusHint: 'exited',
      snapshot: {
        runId: 'run-activity',
        attemptId: 'attempt_1',
        stepId: 'step-1',
        stepKey: 'developer',
        role: 'developer',
        runner: 'script',
        status: 'exited',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastEventAt: '2026-01-01T00:00:01.000Z',
        stdoutBytes: 3,
        stderrBytes: 0,
        eventCount: 2,
        artifactRef: 'run-activity/attempt_1',
      },
    },
    {
      cursor: 'a2',
      runId: 'run-activity',
      attemptId: 'attempt_2',
      stepId: 'step-2',
      stepKey: 'reviewer',
      at: '2026-01-01T00:00:02.000Z',
      kind: 'status',
      statusHint: 'running',
      snapshot: {
        runId: 'run-activity',
        attemptId: 'attempt_2',
        stepId: '/Users/anton/private-step',
        stepKey: '/Users/anton/private-key',
        role: 'reviewer',
        runner: 'claude-code',
        status: 'running',
        startedAt: '2026-01-01T00:00:02.000Z',
        lastEventAt: '2026-01-01T00:00:03.000Z',
        lastOutputAt: '2026-01-01T00:00:03.000Z',
        stdoutBytes: 7,
        stderrBytes: 0,
        eventCount: 1,
        artifactRef: '/Users/anton/run-activity/attempt_2',
        error: 'failed in /Users/anton/projects/revisium with ghp_12345678901234567890',
      },
    },
  ];
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    now: () => Date.parse('2026-01-01T00:00:03.500Z'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });

  const activity = await service.getAgentActivity('run-activity');

  assert.equal(activity?.aggregateStatus, 'running');
  assert.equal(activity?.latestActivityAt, '2026-01-01T00:00:03.000Z');
  assert.equal(activity?.latestOutputAt, '2026-01-01T00:00:03.000Z');
  assert.deepEqual(activity?.attempts.map((attempt) => attempt.attemptId), ['attempt_1', 'attempt_2']);
  const reviewer = activity?.attempts[1];
  assert.equal(reviewer?.stepId, '[REDACTED_PATH]');
  assert.equal(reviewer?.stepKey, '[REDACTED_PATH]');
  assert.equal(reviewer?.artifactRef, '[REDACTED_PATH]');
  assert.equal(reviewer?.error?.includes('/Users/anton'), false);
  assert.equal(reviewer?.error?.includes('ghp_12345678901234567890'), false);
});

test('agent observability: getAgentActivity checks run existence before stale DBOS activity', async () => {
  let eventRead = false;
  let streamRead = false;
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => false,
    dbos: {
      async getEvent<T>(): Promise<T> {
        eventRead = true;
        return {
          runId: 'run-missing',
          aggregateStatus: 'running',
          latestActivityAt: '2026-01-01T00:00:00.000Z',
          attempts: [],
        } as T;
      },
      readStream<T>() {
        streamRead = true;
        return (async function* () {
          yield {
            cursor: 'stale',
            runId: 'run-missing',
            attemptId: 'attempt_1',
            stepId: 'step-1',
            at: '2026-01-01T00:00:00.000Z',
            kind: 'status',
          } as T;
        })();
      },
    },
  });

  await assert.rejects(() => service.getAgentActivity('run-missing'), (error) => {
    assertObsError(error, 'RUN_NOT_FOUND');
    return true;
  });
  assert.equal(eventRead, false);
  assert.equal(streamRead, false);
});

test('agent observability: getAgentActivity redacts DBOS event snapshot errors', async () => {
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    runExists: () => true,
    dbos: {
      async getEvent<T>(): Promise<T> {
        return {
          runId: 'run-event',
          aggregateStatus: 'failed',
          latestActivityAt: '2026-01-01T00:00:01.000Z',
          attempts: [{
            runId: 'run-event',
            attemptId: 'attempt_1',
            stepId: 'step-1',
            role: 'developer',
            runner: 'claude-code',
            status: 'failed',
            startedAt: '2026-01-01T00:00:00.000Z',
            lastEventAt: '2026-01-01T00:00:01.000Z',
            stdoutBytes: 0,
            stderrBytes: 1,
            eventCount: 1,
            artifactRef: '/Users/anton/run-event/attempt_1',
            error: 'stderr at /Users/anton/secret with github_pat_12345678901234567890',
          }],
        } as T;
      },
      readStream: async function* () {},
    },
  });

  const activity = await service.getAgentActivity('run-event');

  assert.equal(activity?.attempts[0]?.artifactRef, '[REDACTED_PATH]');
  assert.equal(activity?.attempts[0]?.error?.includes('/Users/anton'), false);
  assert.equal(activity?.attempts[0]?.error?.includes('github_pat_12345678901234567890'), false);
});

test('agent observability: readAgentOutputEvents reports cursorExpired when requested cursor is unavailable', async () => {
  const events: AgentOutputEvent[] = [
    {
      cursor: 'agent-output-v1:attempt_1:output:stdout:0:1',
      runId: 'run-cursor',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'output',
    },
  ];
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });

  const page = await service.readAgentOutputEvents({
    runId: 'run-cursor',
    cursor: 'agent-output-v1:missing',
    limit: 10,
  });

  assert.equal(page.cursorExpired, true);
  assert.deepEqual(page.events, []);
});

test('agent observability: readAgentOutputEvents caps pre-cursor scanning for missing cursors', async () => {
  const events: AgentOutputEvent[] = Array.from({ length: 1_500 }, (_, i) => ({
    cursor: `agent-output-v1:run-long:attempt_1:output:stdout:${i}:1`,
    runId: 'run-long',
    attemptId: 'attempt_1',
    stepId: 'step-1',
    at: '2026-01-01T00:00:00.000Z',
    kind: 'output',
  }));
  let consumed = 0;
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) {
          consumed += 1;
          yield event as T;
        }
      },
    },
  });

  const page = await service.readAgentOutputEvents({
    runId: 'run-long',
    cursor: 'agent-output-v1:run-long:missing',
    limit: 1,
  });

  assert.equal(page.cursorExpired, true);
  assert.deepEqual(page.events, []);
  assert.equal(consumed, 1_000);
});

test('agent observability: watchAgentOutput resumes after a found cursor', async () => {
  const events: AgentOutputEvent[] = [
    {
      cursor: 'agent-output-v1:run-watch:attempt_1:output:stdout:0:1',
      runId: 'run-watch',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      at: '2026-01-01T00:00:00.000Z',
      kind: 'output',
    },
    {
      cursor: 'agent-output-v1:run-watch:attempt_1:output:stdout:1:1',
      runId: 'run-watch',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      at: '2026-01-01T00:00:01.000Z',
      kind: 'output',
    },
  ];
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });
  const yielded: AgentOutputEvent[] = [];

  for await (const event of service.watchAgentOutput({ runId: 'run-watch', cursor: events[0]!.cursor })) {
    yielded.push(event);
  }

  assert.deepEqual(yielded.map((event) => event.cursor), [events[1]!.cursor]);
});

test('agent observability: watchAgentOutput throws cursor expired after bounded missing-cursor scan', async () => {
  const events: AgentOutputEvent[] = Array.from({ length: 1_500 }, (_, i) => ({
    cursor: `agent-output-v1:run-watch-long:attempt_1:output:stdout:${i}:1`,
    runId: 'run-watch-long',
    attemptId: 'attempt_1',
    stepId: 'step-1',
    at: '2026-01-01T00:00:00.000Z',
    kind: 'output',
  }));
  let consumed = 0;
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) {
          consumed += 1;
          yield event as T;
        }
      },
    },
  });

  await assert.rejects(
    async () => {
      for await (const _event of service.watchAgentOutput({
        runId: 'run-watch-long',
        cursor: 'agent-output-v1:run-watch-long:missing',
      })) {
        // no events should be yielded before the missing cursor is found
      }
    },
    (error) => {
      assertObsError(error, 'STREAM_CURSOR_EXPIRED');
      return true;
    },
  );
  assert.equal(consumed, 1_000);
});

test('agent observability: readAgentOutputEvents rejects obvious invalid cursor input', async () => {
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* () {},
    },
  });

  await assert.rejects(
    () => service.readAgentOutputEvents({ runId: 'run-cursor', cursor: '/Users/anton/secret' }),
    (error) => {
      assertObsError(error, 'VALIDATION_FAILURE');
      return true;
    },
  );
});

test('agent observability: getAgentActivity derives idle from stale running activity at read time', async () => {
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    idleThresholdMs: 1_000,
    now: () => Date.parse('2026-01-01T00:00:03.000Z'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        yield {
          cursor: 'agent-output-v1:attempt_1:status:running:1',
          runId: 'run-idle',
          attemptId: 'attempt_1',
          stepId: 'step-1',
          at: '2026-01-01T00:00:00.000Z',
          kind: 'status',
          snapshot: {
            runId: 'run-idle',
            attemptId: 'attempt_1',
            stepId: 'step-1',
            role: 'developer',
            runner: 'claude-code',
            status: 'running',
            startedAt: '2026-01-01T00:00:00.000Z',
            lastEventAt: '2026-01-01T00:00:00.000Z',
            lastOutputAt: '2026-01-01T00:00:01.000Z',
            stdoutBytes: 5,
            stderrBytes: 0,
            eventCount: 1,
            artifactRef: 'run-idle/attempt_1',
          },
        } satisfies AgentOutputEvent as T;
      },
    },
  });

  const activity = await service.getAgentActivity('run-idle');

  assert.equal(activity?.aggregateStatus, 'idle');
  assert.equal(activity?.attempts[0]?.status, 'idle');
});

test('agent observability: idle classification does not overwrite terminal statuses', async () => {
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    idleThresholdMs: 1_000,
    now: () => Date.parse('2026-01-01T01:00:00.000Z'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const status of ['failed', 'permission_blocked', 'exited'] as const) {
          yield {
            cursor: `agent-output-v1:attempt_${status}:status:${status}:1`,
            runId: 'run-terminal',
            attemptId: `attempt_${status}`,
            stepId: `step-${status}`,
            at: '2026-01-01T00:00:00.000Z',
            kind: 'status',
            snapshot: {
              runId: 'run-terminal',
              attemptId: `attempt_${status}`,
              stepId: `step-${status}`,
              role: 'developer',
              runner: 'claude-code',
              status,
              startedAt: '2026-01-01T00:00:00.000Z',
              lastEventAt: '2026-01-01T00:00:00.000Z',
              stdoutBytes: 0,
              stderrBytes: 0,
              eventCount: 1,
              artifactRef: `run-terminal/attempt_${status}`,
            },
          } satisfies AgentOutputEvent as T;
        }
      },
    },
  });

  const activity = await service.getAgentActivity('run-terminal');

  assert.deepEqual(activity?.attempts.map((attempt) => attempt.status).sort(), ['exited', 'failed', 'permission_blocked']);
  assert.ok(!activity?.attempts.some((attempt) => attempt.status === 'idle'));
  assert.equal(activity?.aggregateStatus, 'failed');
});

test('agent observability: timed_out aggregate status outranks cancelled', async () => {
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const status of ['cancelled', 'timed_out'] as const) {
          yield {
            cursor: `agent-output-v1:attempt_${status}:status:${status}:1`,
            runId: 'run-timeout-precedence',
            attemptId: `attempt_${status}`,
            stepId: `step-${status}`,
            at: '2026-01-01T00:00:00.000Z',
            kind: 'status',
            snapshot: {
              runId: 'run-timeout-precedence',
              attemptId: `attempt_${status}`,
              stepId: `step-${status}`,
              role: 'developer',
              runner: 'claude-code',
              status,
              startedAt: '2026-01-01T00:00:00.000Z',
              lastEventAt: '2026-01-01T00:00:00.000Z',
              stdoutBytes: 0,
              stderrBytes: 0,
              eventCount: 1,
              artifactRef: `run-timeout-precedence/attempt_${status}`,
            },
          } satisfies AgentOutputEvent as T;
        }
      },
    },
  });

  const activity = await service.getAgentActivity('run-timeout-precedence');

  assert.equal(activity?.aggregateStatus, 'timed_out');
});

test('agent observability: getAgentActivity scans beyond the first 1000 stream events for latest snapshots', async () => {
  const events: AgentOutputEvent[] = Array.from({ length: 1_050 }, (_, i) => ({
    cursor: `agent-output-v1:attempt_1:output:stdout:${i}:1`,
    runId: 'run-chatty',
    attemptId: 'attempt_1',
    stepId: 'step-1',
    at: `2026-01-01T00:00:${String(Math.floor(i / 20)).padStart(2, '0')}.000Z`,
    kind: 'output',
    snapshot: {
      runId: 'run-chatty',
      attemptId: 'attempt_1',
      stepId: 'step-1',
      role: 'developer',
      runner: 'claude-code',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2026-01-01T00:00:52.000Z',
      lastOutputAt: '2026-01-01T00:00:52.000Z',
      stdoutBytes: i + 1,
      stderrBytes: 0,
      eventCount: i + 1,
      artifactRef: 'run-chatty/attempt_1',
    },
  }));
  const service = new AgentObservabilityService({
    artifactRoot: join(tmpdir(), 'missing-observability-root'),
    now: () => Date.parse('2026-01-01T00:00:52.500Z'),
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        for (const event of events) yield event as T;
      },
    },
  });

  const activity = await service.getAgentActivity('run-chatty');

  assert.equal(activity?.attempts[0]?.stdoutBytes, 1_050);
  assert.equal(activity?.attempts[0]?.eventCount, 1_050);
  assert.equal(activity?.aggregateStatus, 'running');
});

test('agent observability: getAgentActivity falls back to completed artifact attempts', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      runId: 'run-artifacts',
      attemptId: 'attempt_1',
      stdout: 'hello',
      stderr: '',
      meta: {
        runId: 'run-artifacts',
        attemptId: 'attempt_1',
        stepId: 'step-1',
        stepKey: 'developer',
        role: 'developer',
        runner: 'script',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        status: 'finished',
      },
    });
    const service = new AgentObservabilityService({
      artifactRoot: root,
      dbos: {
        getEvent: async () => null,
        readStream: async function* () {},
      },
    });

    const activity = await service.getAgentActivity('run-artifacts');

    assert.equal(activity?.aggregateStatus, 'exited');
    assert.equal(activity?.attempts[0]?.stdoutBytes, 5);
    assert.equal(activity?.attempts[0]?.artifactRef, 'run-artifacts/attempt_1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: runner from meta.json surfaces via listAgentAttempts', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      meta: {
        stepId: 'step-1',
        role: 'developer',
        runner: 'claude-code',
        startedAt: '2026-06-01T00:00:00.000Z',
        status: 'finished',
        code: 0,
      },
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const attempts = await service.listAgentAttempts('run-1');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.runner, 'claude-code', 'runner from meta.json should surface');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('agent observability: missing runner in meta falls back to "unknown"', async () => {
  const root = tempRoot();
  try {
    writeAttempt(root, {
      meta: {
        stepId: 'step-1',
        role: 'developer',
        startedAt: '2026-06-01T00:00:00.000Z',
        status: 'finished',
        code: 0,
      },
    });
    const service = new AgentObservabilityService({ artifactRoot: root });

    const attempts = await service.listAgentAttempts('run-1');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.runner, 'unknown', 'absent runner should fall back to unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
