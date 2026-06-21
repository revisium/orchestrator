import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentActivityReporter } from './agent-activity-reporter.js';
import type { AgentOutputEvent } from './types.js';

const BASE = {
  runId: 'run-1',
  attemptId: 'attempt_1',
  stepId: 'step-1',
  stepKey: 'developer',
  role: 'developer',
  runner: 'claude-code',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
};

test('agent activity reporter: emits ordered started, output, parsed, and finished events', async () => {
  const events: AgentOutputEvent[] = [];
  const reporter = createAgentActivityReporter(BASE, async (event) => {
    events.push(event);
  });

  reporter.started();
  reporter.spawned(123);
  reporter.output('stdout', 'hello');
  reporter.parsed({ type: 'result', preview: 'parsed' });
  reporter.finished({ exitCode: 0, timedOut: false });
  await reporter.flush();

  assert.deepEqual(events.map((event) => event.kind), ['activity', 'status', 'output', 'parsed_event', 'status']);
  assert.deepEqual(events.map((event) => event.attemptSeq), [1, 2, 3, 4, 5]);
  assert.equal(events[2]?.outputOffsetBytes, 0);
  assert.equal(events[2]?.bytes, 5);
  assert.equal(events[2]?.snapshot?.stdoutBytes, 5);
  assert.equal(events.at(-1)?.statusHint, 'exited');
  assert.equal(events.at(-1)?.snapshot?.status, 'exited');
});

test('agent activity reporter: stdout/stderr cursors use byte offsets and retry-stable attempt identity', async () => {
  const events: AgentOutputEvent[] = [];
  const reporter = createAgentActivityReporter(BASE, async (event) => {
    events.push(event);
  });

  reporter.output('stdout', 'abc');
  reporter.output('stdout', 'de');
  reporter.output('stderr', 'err');
  await reporter.flush();

  assert.match(events[0]?.cursor ?? '', /attempt_1:output:stdout:0:3$/);
  assert.match(events[1]?.cursor ?? '', /attempt_1:output:stdout:3:2$/);
  assert.match(events[2]?.cursor ?? '', /attempt_1:output:stderr:0:3$/);
  assert.equal(events[2]?.snapshot?.stdoutBytes, 5);
  assert.equal(events[2]?.snapshot?.stderrBytes, 3);
});

test('agent activity reporter: output cursors are replay-stable and scoped by run id, not prose', async () => {
  const first: AgentOutputEvent[] = [];
  const replay: AgentOutputEvent[] = [];
  const differentRun: AgentOutputEvent[] = [];

  const firstReporter = createAgentActivityReporter(BASE, async (event) => {
    first.push(event);
  });
  const replayReporter = createAgentActivityReporter(BASE, async (event) => {
    replay.push(event);
  });
  const differentRunReporter = createAgentActivityReporter({ ...BASE, runId: 'run-2' }, async (event) => {
    differentRun.push(event);
  });

  firstReporter.output('stdout', 'same text with ghp_123456789012345678901234');
  replayReporter.output('stdout', 'same text with ghp_123456789012345678901234');
  differentRunReporter.output('stdout', 'same text with ghp_123456789012345678901234');
  await Promise.all([firstReporter.flush(), replayReporter.flush(), differentRunReporter.flush()]);

  assert.equal(first[0]?.cursor, replay[0]?.cursor, 'DBOS replay of the same product attempt is stable');
  assert.notEqual(first[0]?.cursor, differentRun[0]?.cursor, 'run id scopes otherwise identical attempt cursors');
  assert.doesNotMatch(first[0]?.cursor ?? '', /ghp_/);
});

test('agent activity reporter: spawned cursor ignores non-replay-stable pid while snapshot records it', async () => {
  const first: AgentOutputEvent[] = [];
  const replay: AgentOutputEvent[] = [];
  const firstReporter = createAgentActivityReporter(BASE, async (event) => {
    first.push(event);
  });
  const replayReporter = createAgentActivityReporter(BASE, async (event) => {
    replay.push(event);
  });

  firstReporter.spawned(111);
  replayReporter.spawned(999);
  await Promise.all([firstReporter.flush(), replayReporter.flush()]);

  assert.equal(first[0]?.cursor, replay[0]?.cursor);
  assert.equal(first[0]?.snapshot?.pid, 111);
  assert.equal(replay[0]?.snapshot?.pid, 999);
  assert.doesNotMatch(first[0]?.cursor ?? '', /111|999/);
});

test('agent activity reporter: redacts secrets and absolute paths from previews and errors', async () => {
  const events: AgentOutputEvent[] = [];
  const reporter = createAgentActivityReporter(BASE, async (event) => {
    events.push(event);
  });

  reporter.output('stderr', 'token ghp_123456789012345678901234 at /Users/anton/secret/file.txt');
  reporter.status('running', {
    preview: 'checking github_pat_123456789012345678901234 in /Users/anton/private',
  });
  reporter.parsed({
    type: 'result',
    preview: 'parsed /private/tmp/result with ghp_123456789012345678901234',
  });
  reporter.failed(new Error('failed in /private/tmp/x with github_pat_123456789012345678901234'));
  await reporter.flush();

  assert.doesNotMatch(events[0]?.preview ?? '', /ghp_/);
  assert.doesNotMatch(events[0]?.preview ?? '', /\/Users\/anton/);
  assert.match(events[0]?.preview ?? '', /\[redacted-path\]/);
  assert.doesNotMatch(events.at(-1)?.preview ?? '', /github_pat_/);
  assert.doesNotMatch(events.at(-1)?.preview ?? '', /\/private\/tmp/);
  for (const event of events) {
    assert.doesNotMatch(event.cursor, /ghp_/);
    assert.doesNotMatch(event.cursor, /github_pat_/);
    assert.doesNotMatch(event.cursor, /\/Users\//);
    assert.doesNotMatch(event.cursor, /\/private\//);
  }
});

test('agent activity reporter: writer failures are non-fatal and flush drains later writes', async () => {
  const events: AgentOutputEvent[] = [];
  let calls = 0;
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    const reporter = createAgentActivityReporter(BASE, async (event) => {
      calls += 1;
      if (calls === 1) throw new Error('dbos unavailable');
      events.push(event);
    });

    reporter.started();
    reporter.output('stdout', 'after failure');
    await reporter.flush();

    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'output');
  } finally {
    console.warn = origWarn;
  }
});

test('agent activity reporter: writer timeout is non-fatal and later writes still run', async () => {
  const events: AgentOutputEvent[] = [];
  let calls = 0;
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    const reporter = createAgentActivityReporter(
      { ...BASE, writeTimeoutMs: 5 },
      async (event) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<void>(() => undefined);
        }
        events.push(event);
      },
    );

    reporter.started();
    const startedAt = Date.now();
    await reporter.flush();
    assert.ok(Date.now() - startedAt < 500, 'flush should not wait for a stalled writer indefinitely');

    reporter.output('stdout', 'after timeout');
    await reporter.flush();

    assert.equal(calls, 2);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'output');
  } finally {
    console.warn = origWarn;
  }
});
