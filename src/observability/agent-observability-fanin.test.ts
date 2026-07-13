import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentObservabilityService } from './agent-observability.service.js';
import { AgentObservabilityError, type AgentOutputEvent, type AgentOutputStreamRegistration } from './types.js';

function registration(attemptId: string, sequence: number): AgentOutputStreamRegistration {
  return { runId: 'run-1', taskId: 'task-1', stepId: `step-${attemptId}`, attemptId, sequence };
}

function event(attemptId: string, attemptSeq: number, statusHint?: AgentOutputEvent['statusHint']): AgentOutputEvent {
  return { cursor: `${attemptId}-${attemptSeq}`, runId: 'run-1', attemptId, attemptSeq, stepId: `step-${attemptId}`, at: new Date(0 + attemptSeq).toISOString(), kind: statusHint ? 'status' : 'output', ...(statusHint ? { statusHint } : {}) };
}

function service(registrations: AgentOutputStreamRegistration[], streams: Record<string, AgentOutputEvent[]>) {
  return new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => registrations,
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>(_runId: string, key: string) {
        for (const item of streams[key.replace('agent-output-v1:', '')] ?? []) yield item as T;
      },
    },
  });
}

test('agent output fan-in preserves registration-order round interleave and cursor replay', async () => {
  const registrations = [registration('attempt-a', 1), registration('attempt-b', 2)];
  const svc = service(registrations, { 'attempt-a': [event('attempt-a', 1), event('attempt-a', 2, 'exited')], 'attempt-b': [event('attempt-b', 1)] });
  const first = await svc.readAgentOutputEvents({ runId: 'run-1', limit: 1 });
  assert.equal(first.events[0]?.attemptId, 'attempt-a');
  const second = await svc.readAgentOutputEvents({ runId: 'run-1', cursor: first.nextCursor, limit: 10 });
  assert.deepEqual(second.events.map((item) => item.attemptId), ['attempt-a', 'attempt-b']);
  assert.ok((second.nextCursor?.length ?? 0) <= 512);
});

test('agent output fan-in returns an empty page when re-reading a caught-up tail cursor', async () => {
  const registrations = [registration('attempt-a', 1)];
  const streams = { 'attempt-a': [event('attempt-a', 1), event('attempt-a', 2, 'exited')] };
  const source = service(registrations, streams);
  const page = await source.readAgentOutputEvents({ runId: 'run-1', limit: 10 });
  const tail = await source.readAgentOutputEvents({ runId: 'run-1', cursor: page.nextCursor, limit: 10 });
  assert.deepEqual(tail.events, []);
  assert.equal(tail.cursorExpired, false);
});

test('agent output fan-in appends registrations and rejects a changed prefix', async () => {
  const original = [registration('attempt-a', 1)];
  const svc = service(original, { 'attempt-a': [] });
  const cursor = (await svc.readAgentOutputEvents({ runId: 'run-1' })).nextCursor!;
  const appended = service([...original, registration('attempt-b', 2)], { 'attempt-a': [], 'attempt-b': [event('attempt-b', 1)] });
  const page = await appended.readAgentOutputEvents({ runId: 'run-1', cursor });
  assert.deepEqual(page.events.map((item) => item.attemptId), ['attempt-b']);
  const substituted = service([registration('attempt-other', 1)], { 'attempt-other': [] });
  await assert.rejects(() => substituted.readAgentOutputEvents({ runId: 'run-1', cursor }), (error) => error instanceof AgentObservabilityError && error.code === 'STREAM_CURSOR_EXPIRED');
});

test('agent output fan-in rejects malformed order and enforces read capacity', async () => {
  const malformed = service([registration('attempt-a', 1)], { 'attempt-a': [event('attempt-a', 2), event('attempt-a', 1)] });
  await assert.rejects(() => malformed.readAgentOutputEvents({ runId: 'run-1' }), /malformed or reordered/);
  const tooMany = Array.from({ length: 65 }, (_, index) => registration(`attempt-${index}`, index + 1));
  const capped = service(tooMany, {});
  await assert.rejects(() => capped.readAgentOutputEvents({ runId: 'run-1' }), (error) => error instanceof AgentObservabilityError && error.code === 'OBSERVABILITY_CAPACITY_EXCEEDED');
});

test('agent output fan-in returns an empty page for zero registrations', async () => {
  const page = await service([], {}).readAgentOutputEvents({ runId: 'run-1' });
  assert.deepEqual(page.events, []);
  assert.equal(page.nextCursor, undefined);
});

test('agent output watch discovers late registrations and drains after terminal status', async () => {
  const first = registration('attempt-a', 1);
  const late = registration('attempt-b', 2);
  let discoveryCalls = 0;
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => {
      discoveryCalls += 1;
      return discoveryCalls < 2 ? [first] : [first, late];
    },
    runStatus: async () => discoveryCalls >= 3 ? 'completed' : 'running',
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>(_runId: string, key: string) {
        yield event(key.endsWith('attempt-a') ? 'attempt-a' : 'attempt-b', 1) as T;
      },
    },
  });
  const events: AgentOutputEvent[] = [];
  for await (const item of svc.watchAgentOutput({ runId: 'run-1' })) events.push(item);
  assert.deepEqual(events.map((item) => item.attemptId), ['attempt-a', 'attempt-b']);
  assert.ok(discoveryCalls >= 2);
});

test('agent output watch final-drains and terminates when raw run status is paused', async () => {
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1)],
    runStatus: async () => 'paused',
    dbos: {
      getEvent: async () => null,
      readStream: async function* <T>() {
        yield event('attempt-a', 1, 'failed') as T;
      },
    },
  });
  const events: AgentOutputEvent[] = [];
  for await (const item of svc.watchAgentOutput({ runId: 'run-1' })) events.push(item);
  assert.deepEqual(events.map((item) => item.attemptSeq), [1]);
});

test('agent output fan-in expires a valid cursor when its high watermark exceeds the bounded scan', async () => {
  const registrations = [registration('attempt-a', 1)];
  const cursorSource = service(registrations, { 'attempt-a': [event('attempt-a', 1_500)] });
  const cursor = (await cursorSource.readAgentOutputEvents({ runId: 'run-1' })).nextCursor!;
  const events = Array.from({ length: 1_500 }, (_, index) => event('attempt-a', index + 1));
  const capped = service(registrations, { 'attempt-a': events });
  await assert.rejects(() => capped.readAgentOutputEvents({ runId: 'run-1', cursor }), (error) => error instanceof AgentObservabilityError && error.code === 'STREAM_CURSOR_EXPIRED');
});

function fakeGenerator(
  next: () => Promise<IteratorResult<AgentOutputEvent, void>>,
  onReturn: () => void,
): AsyncGenerator<AgentOutputEvent, void, unknown> {
  return {
    next,
    return: async () => { onReturn(); return { done: true, value: undefined }; },
    throw: async (error: unknown) => { throw error; },
    [Symbol.asyncIterator]() { return this; },
  } as unknown as AsyncGenerator<AgentOutputEvent, void, unknown>;
}

test('watch memoizes normalization after a poll timeout and processes a quiet event once', async () => {
  let nextCalls = 0;
  let returnCalls = 0;
  const stream = fakeGenerator(async () => {
    nextCalls += 1;
    if (nextCalls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 275));
      return { done: false, value: event('attempt-a', 1) };
    }
    return new Promise<IteratorResult<AgentOutputEvent, void>>(() => undefined);
  }, () => { returnCalls += 1; });
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1)],
    runStatus: async () => 'running',
    dbos: { getEvent: async () => null, readStream: <T>() => stream as unknown as AsyncGenerator<T, void, unknown> },
  });
  const iterator = svc.watchAgentOutput({ runId: 'run-1' });
  const result = await iterator.next();
  assert.equal(result.value?.attemptSeq, 1);
  assert.equal(nextCalls, 1, 'the timeout and event race must share one generator.next execution');
  await iterator.return();
  assert.equal(returnCalls, 1);
});

test('watch rethrows a late strict-normalization failure instead of consuming the bad event', async () => {
  let nextCalls = 0;
  const stream = (async function* () {
    nextCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 275));
    yield { ...event('attempt-a', 1), stepId: '' } as AgentOutputEvent;
    nextCalls += 1;
    yield event('attempt-a', 2);
  })();
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1)],
    runStatus: async () => 'running',
    dbos: { getEvent: async () => null, readStream: <T>() => stream as unknown as AsyncGenerator<T, void, unknown> },
  });
  const iterator = svc.watchAgentOutput({ runId: 'run-1' });
  await assert.rejects(() => iterator.next(), /malformed or reordered/);
  assert.equal(nextCalls, 1);
  await iterator.return();
});

test('watch serves three near-simultaneous streams exactly once', async () => {
  const streams = new Map<string, AsyncGenerator<AgentOutputEvent, void, unknown>>();
  for (const [attemptId, delay] of [['attempt-a', 1], ['attempt-b', 2], ['attempt-c', 3]] as const) {
    streams.set(attemptId, (async function* () {
      await new Promise((resolve) => setTimeout(resolve, delay));
      yield event(attemptId, 1);
      await new Promise<never>(() => undefined);
    })());
  }
  let statusCalls = 0;
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1), registration('attempt-b', 2), registration('attempt-c', 3)],
    runStatus: async () => statusCalls++ > 0 ? 'completed' : 'running',
    dbos: { getEvent: async () => null, readStream: <T>(_runId: string, key: string) => streams.get(key.replace('agent-output-v1:', ''))! as unknown as AsyncGenerator<T, void, unknown> },
  });
  const iterator = svc.watchAgentOutput({ runId: 'run-1' });
  const received: string[] = [];
  for (let index = 0; index < 3; index++) received.push((await iterator.next()).value!.attemptId);
  assert.deepEqual(received.sort(), ['attempt-a', 'attempt-b', 'attempt-c']);
  await iterator.return();
});

test('finite fan-in polls 64 idle streams in one concurrent round and closes them promptly', async () => {
  const registrations = Array.from({ length: 64 }, (_, index) => registration(`attempt-${index}`, index + 1));
  let nextCalls = 0;
  let returnCalls = 0;
  const svc = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests',
    runExists: () => true,
    listAgentOutputStreamRegistrations: async () => registrations,
    dbos: {
      getEvent: async () => null,
      readStream: <T>() => fakeGenerator(async () => {
        nextCalls += 1;
        return new Promise<IteratorResult<AgentOutputEvent, void>>(() => undefined);
      }, () => { returnCalls += 1; }) as unknown as AsyncGenerator<T, void, unknown>,
    },
  });
  const page = await svc.readAgentOutputEvents({ runId: 'run-1', timeoutMs: 5 });
  assert.deepEqual(page.events, []);
  assert.equal(nextCalls, 64);
  assert.equal(returnCalls, 64);
});

test('finite fan-in expires cursor 1000 when the bounded scan makes no progress', async () => {
  const registrations = [registration('attempt-a', 1)];
  const cursor = (await service(registrations, { 'attempt-a': [event('attempt-a', 1_000)] }).readAgentOutputEvents({ runId: 'run-1' })).nextCursor!;
  const source = service(registrations, { 'attempt-a': Array.from({ length: 1_000 }, (_, index) => event('attempt-a', index + 1)) });
  await assert.rejects(() => source.readAgentOutputEvents({ runId: 'run-1', cursor }), (error) => error instanceof AgentObservabilityError && error.code === 'STREAM_CURSOR_EXPIRED');
});

test('finite and watch cancellation attempt bounded reader cleanup without waiting for parked next', async () => {
  let finiteReturns = 0;
  const finite = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests', runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1)],
    dbos: { getEvent: async () => null, readStream: <T>() => fakeGenerator(() => new Promise<IteratorResult<AgentOutputEvent, void>>(() => undefined), () => { finiteReturns += 1; }) as unknown as AsyncGenerator<T, void, unknown> },
  });
  await finite.readAgentOutputEvents({ runId: 'run-1', timeoutMs: 5 });
  assert.equal(finiteReturns, 1);

  let watchReturns = 0;
  const watch = new AgentObservabilityService({
    artifactRoot: '/tmp/revo-observability-tests', runExists: () => true,
    listAgentOutputStreamRegistrations: async () => [registration('attempt-a', 1)],
    dbos: { getEvent: async () => null, readStream: <T>() => fakeGenerator(async () => ({ done: false, value: event('attempt-a', 1) }), () => { watchReturns += 1; }) as unknown as AsyncGenerator<T, void, unknown> },
  });
  const iterator = watch.watchAgentOutput({ runId: 'run-1' });
  await iterator.next();
  await iterator.return();
  assert.equal(watchReturns, 1);
});
