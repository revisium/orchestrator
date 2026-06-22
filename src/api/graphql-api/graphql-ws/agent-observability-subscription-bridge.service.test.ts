import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentObservabilityError } from '../../../observability/types.js';
import type { AgentOutputEvent, AgentRunActivity } from '../../../observability/types.js';
import { AgentObservabilitySubscriptionBridge } from './agent-observability-subscription-bridge.service.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true);
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function outputEvent(patch: Partial<AgentOutputEvent> = {}): AgentOutputEvent {
  return {
    cursor: 'c1',
    runId: 'run_1',
    attemptId: 'attempt_1',
    attemptSeq: 1,
    stepId: 'step_1',
    stepKey: 'developer',
    at: '2026-01-01T00:00:00.000Z',
    kind: 'output',
    stream: 'agent-jsonl',
    bytes: 12,
    preview: 'bounded preview',
    parsedType: 'assistant_message',
    statusHint: 'running',
    snapshot: {
      runId: 'run_1',
      attemptId: 'attempt_1',
      stepId: 'step_1',
      role: 'developer',
      runner: 'claude-code',
      status: 'running',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastEventAt: '2026-01-01T00:00:00.000Z',
      stdoutBytes: 12,
      stderrBytes: 0,
      eventCount: 1,
      artifactRef: 'run_1/attempt_1',
    },
    ...patch,
  };
}

function activity(): AgentRunActivity {
  return {
    runId: 'run_1',
    aggregateStatus: 'running',
    latestActivityAt: '2026-01-01T00:00:00.000Z',
    latestOutputAt: '2026-01-01T00:00:00.000Z',
    attempts: [
      {
        runId: 'run_1',
        attemptId: 'attempt_1',
        stepId: 'step_1',
        role: 'developer',
        runner: 'claude-code',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        lastEventAt: '2026-01-01T00:00:00.000Z',
        lastStream: 'agent-jsonl',
        stdoutBytes: 12,
        stderrBytes: 0,
        eventCount: 1,
        artifactRef: 'run_1/attempt_1',
      },
    ],
  };
}

test('AgentObservabilitySubscriptionBridge publishes mapped public activity and output payloads', async () => {
  const api = {
    async *watchAgentActivity() {
      await delay(35);
      yield activity();
    },
    async *watchAgentOutput() {
      await delay(35);
      yield outputEvent();
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);

  const activityIterator = bridge.subscribeToActivity('run_1');
  const outputIterator = bridge.subscribeToOutput('run_1');
  const activityNext = await activityIterator.next();
  const outputNext = await outputIterator.next();
  await activityIterator.return?.(undefined);
  await outputIterator.return?.(undefined);

  assert.equal(activityNext.done, false);
  assert.equal(outputNext.done, false);
  assert.equal((activityNext.value as { runId: string }).runId, 'run_1');
  assert.equal((activityNext.value as { runAgentActivityUpdated: { attempts: Array<{ lastStream: string }> } }).runAgentActivityUpdated.attempts[0]?.lastStream, 'agent_jsonl');
  const output = (outputNext.value as { runAgentOutputAppended: Record<string, unknown> }).runAgentOutputAppended;
  assert.equal(output.stream, 'agent_jsonl');
  assert.equal(output.preview, 'bounded preview');
  assert.equal(Object.hasOwn(output, 'snapshot'), false);
});

test('AgentObservabilitySubscriptionBridge drops bounded historical output before live-tail publish', async () => {
  const api = {
    async *watchAgentActivity() {
      yield activity();
    },
    async *watchAgentOutput() {
      yield outputEvent({ cursor: 'historical-1', preview: 'historical one' });
      yield outputEvent({ cursor: 'historical-2', preview: 'historical two' });
      await delay(35);
      yield outputEvent({ cursor: 'live-1', preview: 'live event' });
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);

  const iterator = bridge.subscribeToOutput('run_1');
  const next = await iterator.next();
  await iterator.return?.(undefined);

  assert.equal(next.done, false);
  const output = (next.value as { runAgentOutputAppended: Record<string, unknown> }).runAgentOutputAppended;
  assert.equal(output.cursor, 'live-1');
  assert.equal(output.preview, 'live event');
});

test('AgentObservabilitySubscriptionBridge rejects subscribers instead of replaying overlong history', async () => {
  const api = {
    async *watchAgentActivity() {
      yield activity();
    },
    async *watchAgentOutput() {
      for (let i = 0; i < 1_001; i += 1) {
        yield outputEvent({ cursor: `historical-${i}` });
      }
      await delay(35);
      yield outputEvent({ cursor: 'live-1' });
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);
  (bridge as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  const iterator = bridge.subscribeToOutput('run_1');

  await assert.rejects(() => iterator.next(), (error) => {
    const err = error as { code?: string; message?: string };
    assert.equal(err.code, 'AGENT_OBSERVABILITY_REFETCH_REQUIRED');
    assert.match(err.message ?? '', /bounded live-tail warmup|refetch current agent observability state/);
    return true;
  });
});

test('AgentObservabilitySubscriptionBridge shares one watcher per run and topic until subscribers release', async () => {
  let activityWatches = 0;
  const api = {
    async *watchAgentActivity() {
      activityWatches += 1;
      yield await new Promise<AgentRunActivity>(() => undefined);
    },
    async *watchAgentOutput() {
      yield await Promise.reject(new Error('unused'));
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);
  const state = bridge as unknown as { watchers: Map<string, unknown> };

  const first = bridge.subscribeToActivity('run_1');
  const second = bridge.subscribeToActivity('run_1');
  await waitFor(() => activityWatches === 1);
  assert.equal(state.watchers.size, 1);

  await first.return?.(undefined);
  assert.equal(state.watchers.size, 1);

  await second.return?.(undefined);
  assert.equal(state.watchers.size, 0);
});

test('AgentObservabilitySubscriptionBridge drops mismatched run payloads before subscribers', async () => {
  const api = {
    async *watchAgentActivity() {
      await delay(35);
      yield { ...activity(), runId: 'run_2' };
    },
    async *watchAgentOutput() {
      await delay(35);
      yield outputEvent({ runId: 'run_2' });
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);

  const activityIterator = bridge.subscribeToActivity('run_1');
  const outputIterator = bridge.subscribeToOutput('run_1');
  const activityNext = await activityIterator.next();
  const outputNext = await outputIterator.next();

  assert.equal(activityNext.done, true);
  assert.equal(outputNext.done, true);
});

test('AgentObservabilitySubscriptionBridge contains watch failures and tells clients to refetch', async () => {
  const warnings: string[] = [];
  const api = {
    async *watchAgentActivity() {
      yield await Promise.reject(new AgentObservabilityError('STREAM_CURSOR_EXPIRED', 'stream cursor expired'));
    },
    async *watchAgentOutput() {
      yield await Promise.reject(new Error('unused'));
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);
  (bridge as unknown as { logger: { warn: (message: string) => void } }).logger = {
    warn: (message) => warnings.push(message),
  };

  const iterator = bridge.subscribeToActivity('run_1');
  await assert.rejects(() => iterator.next(), (error) => {
    const err = error as { code?: string; message?: string };
    assert.equal(err.code, 'AGENT_OBSERVABILITY_REFETCH_REQUIRED');
    assert.match(err.message ?? '', /stream cursor expired|refetch current agent observability state/);
    return true;
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /STREAM_CURSOR_EXPIRED|stream cursor expired/);
  assert.match(warnings[0] ?? '', /refetch current agent observability state/);
});

test('AgentObservabilitySubscriptionBridge rejects subscribers with Error instances for non-Error watch failures', async () => {
  const api = {
    async *watchAgentActivity() {
      const error: unknown = 'cursor expired';
      throw error;
      yield activity();
    },
    async *watchAgentOutput() {
      yield await Promise.reject(new Error('unused'));
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);
  (bridge as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };

  const iterator = bridge.subscribeToActivity('run_1');
  await assert.rejects(() => iterator.next(), (error) => {
    assert.ok(error instanceof Error);
    const err = error as { code?: string; message?: string };
    assert.equal(err.code, 'AGENT_OBSERVABILITY_REFETCH_REQUIRED');
    assert.match(err.message ?? '', /cursor expired|refetch current agent observability state/);
    return true;
  });
});

test('AgentObservabilitySubscriptionBridge watch failure preempts buffered payloads for slow subscribers', async () => {
  const api = {
    async *watchAgentActivity() {
      yield activity();
    },
    async *watchAgentOutput() {
      await delay(35);
      yield outputEvent({ cursor: 'live-1', preview: 'buffered one' });
      yield outputEvent({ cursor: 'live-2', preview: 'buffered two' });
      throw new AgentObservabilityError('STREAM_CURSOR_EXPIRED', 'stream cursor expired');
    },
  };
  const bridge = new AgentObservabilitySubscriptionBridge(api as never);
  (bridge as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };

  const iterator = bridge.subscribeToOutput('run_1');
  await delay(80);
  await waitFor(() => {
    const state = bridge as unknown as { watchers: Map<string, unknown> };
    return state.watchers.size === 0;
  });

  await assert.rejects(() => iterator.next(), (error) => {
    const err = error as { code?: string; message?: string };
    assert.equal(err.code, 'AGENT_OBSERVABILITY_REFETCH_REQUIRED');
    assert.match(err.message ?? '', /stream cursor expired|refetch current agent observability state/);
    return true;
  });
});
