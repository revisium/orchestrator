import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCanonicalActivitySignal } from './activity-signal.js';
import type { AgentRunActivity } from './types.js';

const activity: AgentRunActivity = {
  runId: 'run-1',
  aggregateStatus: 'running',
  latestActivityAt: '2026-06-26T10:00:03.000Z',
  latestOutputAt: '2026-06-26T10:00:02.000Z',
  attempts: [
    {
      runId: 'run-1',
      attemptId: 'attempt-1',
      stepId: 'developer',
      role: 'developer',
      runner: 'claude-code',
      status: 'exited',
      startedAt: '2026-06-26T10:00:00.000Z',
      lastEventAt: '2026-06-26T10:00:01.000Z',
      stdoutBytes: 10,
      stderrBytes: 1,
      eventCount: 2,
      artifactRef: 'run-1/attempt-1',
      error: 'raw error detail must stay out of the canonical signal',
    },
    {
      runId: 'run-1',
      attemptId: 'attempt-2',
      stepId: 'review',
      stepKey: 'review#2',
      role: 'reviewer',
      runner: 'codex',
      status: 'running',
      startedAt: '2026-06-26T10:00:01.000Z',
      lastEventAt: '2026-06-26T10:00:03.000Z',
      lastOutputAt: '2026-06-26T10:00:02.000Z',
      stdoutBytes: 20,
      stderrBytes: 3,
      eventCount: 4,
      artifactRef: 'run-1/attempt-2',
      error: 'another raw detail',
    },
  ],
};

test('deriveCanonicalActivitySignal aggregates counters and selects the latest attempt', () => {
  const signal = deriveCanonicalActivitySignal(activity);

  assert.equal(signal?.aggregateStatus, 'running');
  assert.equal(signal?.stdoutBytes, 30);
  assert.equal(signal?.stderrBytes, 4);
  assert.equal(signal?.eventCount, 6);
  assert.equal(signal?.attempt?.attemptId, 'attempt-2');
  assert.equal(signal?.attempt?.stepKey, 'review#2');
});

test('deriveCanonicalActivitySignal omits raw artifact and error details', () => {
  const signal = deriveCanonicalActivitySignal(activity);
  const serialized = JSON.stringify(signal);

  assert.equal(serialized.includes('artifactRef'), false);
  assert.equal(serialized.includes('raw error detail'), false);
});

test('deriveCanonicalActivitySignal preserves empty existing-run activity as a heartbeat source', () => {
  const signal = deriveCanonicalActivitySignal({
    runId: 'run-1',
    aggregateStatus: 'idle',
    latestActivityAt: '2026-06-26T10:00:00.000Z',
    attempts: [],
  });

  assert.equal(signal?.aggregateStatus, 'idle');
  assert.equal(signal?.stdoutBytes, 0);
  assert.equal(signal?.attempt, undefined);
});

test('deriveCanonicalActivitySignal returns undefined when no activity exists', () => {
  assert.equal(deriveCanonicalActivitySignal(null), undefined);
  assert.equal(deriveCanonicalActivitySignal(undefined), undefined);
});
