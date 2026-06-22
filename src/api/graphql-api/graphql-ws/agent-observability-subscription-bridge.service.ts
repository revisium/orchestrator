import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { TaskControlPlaneApiService } from '../../../task-control-plane/task-control-plane-api.service.js';
import type { AgentOutputEvent, AgentRunActivity } from '../../../observability/types.js';
import {
  RUN_AGENT_ACTIVITY_UPDATED_TOPIC,
  RUN_AGENT_OUTPUT_APPENDED_TOPIC,
} from './constants.js';
import {
  mapAgentOutputEventForSubscription,
  mapAgentRunActivityForSubscription,
} from './agent-observability-subscription-mappers.js';

type Topic = typeof RUN_AGENT_ACTIVITY_UPDATED_TOPIC | typeof RUN_AGENT_OUTPUT_APPENDED_TOPIC;

type WatchState = {
  abort: AbortController;
  subscribers: Set<SubscriptionQueue<unknown>>;
};

type SubscriptionIterator<T> = AsyncIterator<T> & AsyncIterable<T>;
type SubscriptionPushResult = 'accepted' | 'closed' | 'overflow';

const LIVE_TAIL_WARMUP_IDLE_MS = 25;
const LIVE_TAIL_WARMUP_MAX_EVENTS = 1_000;
const SUBSCRIPTION_QUEUE_MAX_VALUES = 1_000;
const SUBSCRIPTION_REFETCH_CODE = 'AGENT_OBSERVABILITY_REFETCH_REQUIRED';
const SUBSCRIPTION_REFETCH_MESSAGE = 'agent observability subscription is no longer current; refetch current agent observability state before resubscribing';

export class AgentObservabilitySubscriptionError extends Error {
  constructor(
    public readonly code: 'AGENT_OBSERVABILITY_REFETCH_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'AgentObservabilitySubscriptionError';
  }
}

@Injectable()
export class AgentObservabilitySubscriptionBridge implements OnModuleDestroy {
  private readonly logger = new Logger(AgentObservabilitySubscriptionBridge.name);
  private readonly watchers = new Map<string, WatchState>();

  constructor(
    @Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService,
  ) {}

  onModuleDestroy() {
    for (const state of this.watchers.values()) {
      state.abort.abort();
      for (const subscriber of state.subscribers) subscriber.close();
    }
    this.watchers.clear();
  }

  subscribeToActivity(runId: string): SubscriptionIterator<unknown> {
    return this.retain(runId, RUN_AGENT_ACTIVITY_UPDATED_TOPIC, (signal) => this.watchActivity(runId, signal));
  }

  subscribeToOutput(runId: string): SubscriptionIterator<unknown> {
    return this.retain(runId, RUN_AGENT_OUTPUT_APPENDED_TOPIC, (signal) => this.watchOutput(runId, signal));
  }

  private retain(runId: string, topic: Topic, start: (signal: AbortSignal) => Promise<void>): SubscriptionIterator<unknown> {
    const key = watcherKey(topic, runId);
    const current = this.watchers.get(key);
    const subscriber = new SubscriptionQueue<unknown>(() => this.release(runId, topic, subscriber));
    if (current) {
      current.subscribers.add(subscriber);
      return subscriber;
    }

    const abort = new AbortController();
    const state: WatchState = { abort, subscribers: new Set([subscriber]) };
    this.watchers.set(key, state);
    void start(abort.signal)
      .catch((error) => {
        if (abort.signal.aborted) return;
        const subscriptionError = toSubscriptionError(error);
        this.logger.warn(`${topic} watch stopped for ${runId}: ${subscriptionError.code}; ${diagnosticMessage(error)}`);
        for (const item of state.subscribers) item.fail(subscriptionError);
      })
      .finally(() => {
        const latest = this.watchers.get(key);
        if (latest !== state) return;
        for (const item of state.subscribers) item.close();
        this.watchers.delete(key);
      });
    return subscriber;
  }

  private release(runId: string, topic: Topic, subscriber: SubscriptionQueue<unknown>): void {
    const key = watcherKey(topic, runId);
    const state = this.watchers.get(key);
    if (!state) return;
    state.subscribers.delete(subscriber);
    if (state.subscribers.size > 0) return;
    state.abort.abort();
    this.watchers.delete(key);
  }

  private async watchActivity(runId: string, signal: AbortSignal): Promise<void> {
    await consumeLiveTail(this.api.watchAgentActivity({ runId }), signal, (activity) => this.publishActivity(runId, activity));
  }

  private async watchOutput(runId: string, signal: AbortSignal): Promise<void> {
    await consumeLiveTail(this.api.watchAgentOutput({ runId }), signal, (event) => this.publishOutput(runId, event));
  }

  private publishActivity(runId: string, activity: AgentRunActivity): void {
    if (activity.runId !== runId) return;
    this.publish(RUN_AGENT_ACTIVITY_UPDATED_TOPIC, runId, {
      runAgentActivityUpdated: mapAgentRunActivityForSubscription(activity),
      runId,
    });
  }

  private publishOutput(runId: string, event: AgentOutputEvent): void {
    if (event.runId !== runId) return;
    this.publish(RUN_AGENT_OUTPUT_APPENDED_TOPIC, runId, {
      runAgentOutputAppended: mapAgentOutputEventForSubscription(event),
      runId,
    });
  }

  private publish(topic: Topic, runId: string, payload: Record<string, unknown>): void {
    const state = this.watchers.get(watcherKey(topic, runId));
    if (!state) return;
    for (const subscriber of state.subscribers) {
      const result = subscriber.push(payload);
      if (result === 'overflow') {
        this.logger.warn(`${topic} subscriber queue overflow for ${runId}: ${SUBSCRIPTION_REFETCH_CODE}; queued values exceeded ${SUBSCRIPTION_QUEUE_MAX_VALUES}`);
      }
    }
  }
}

function watcherKey(topic: Topic, runId: string): string {
  return `${topic}:${runId}`;
}

function diagnosticMessage(error: unknown): string {
  return stringifyReason(error);
}

function toError(error: unknown, fallbackMessage: string): Error {
  if (error instanceof Error) return error;
  return new Error(error === undefined ? fallbackMessage : stringifyReason(error));
}

function stringifyReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  if (reason === undefined) return 'undefined';
  if (reason === null) return 'null';
  if (typeof reason === 'number' || typeof reason === 'boolean' || typeof reason === 'bigint') return `${reason}`;
  if (typeof reason === 'symbol') return reason.description ? `Symbol(${reason.description})` : 'Symbol()';
  if (typeof reason === 'function') return reason.name ? `[function ${reason.name}]` : '[function]';
  try {
    return JSON.stringify(reason) ?? 'unserializable object';
  } catch {
    return 'unserializable object';
  }
}

function toSubscriptionError(_error: unknown): AgentObservabilitySubscriptionError {
  return refetchRequiredSubscriptionError();
}

function refetchRequiredSubscriptionError(): AgentObservabilitySubscriptionError {
  return new AgentObservabilitySubscriptionError(SUBSCRIPTION_REFETCH_CODE, SUBSCRIPTION_REFETCH_MESSAGE);
}

async function consumeLiveTail<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  publish: (value: T) => void,
): Promise<void> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();
  let live = false;
  let skipped = 0;
  const abort = () => {
    void iterator.return?.(undefined).catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!signal.aborted) {
      const next = live ? await pending : await nextWithTimeout(pending, LIVE_TAIL_WARMUP_IDLE_MS);
      if (next === 'timeout') {
        live = true;
        continue;
      }
      pending = iterator.next();
      if (next.done || signal.aborted) break;
      if (!live) {
        skipped += 1;
        if (skipped > LIVE_TAIL_WARMUP_MAX_EVENTS) throw liveTailOverflowError();
        continue;
      }
      publish(next.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await iterator.return?.(undefined).catch(() => undefined);
  }
}

function liveTailOverflowError(): AgentObservabilitySubscriptionError {
  return refetchRequiredSubscriptionError();
}

async function nextWithTimeout<T>(
  pending: Promise<IteratorResult<T, void>>,
  timeoutMs: number,
): Promise<IteratorResult<T, void> | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<IteratorResult<T, void> | 'timeout'>([
      pending,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type QueueWaiter<T> = {
  resolve: (value: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
};

class SubscriptionQueue<T> implements SubscriptionIterator<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<QueueWaiter<T>> = [];
  private closed = false;
  private error: Error | undefined;
  private released = false;

  constructor(
    private readonly onReturn: () => void,
    private readonly maxValues = SUBSCRIPTION_QUEUE_MAX_VALUES,
  ) {}

  [Symbol.asyncIterator](): SubscriptionIterator<T> {
    return this;
  }

  next(): Promise<IteratorResult<T>> {
    if (this.error) return Promise.reject(this.error);
    if (this.values.length > 0) {
      return Promise.resolve({ done: false, value: this.values.shift() as T });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    this.release();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this.close();
    this.release();
    throw toError(error, 'subscription iterator thrown');
  }

  push(value: T): SubscriptionPushResult {
    if (this.closed || this.error) return 'closed';
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return 'accepted';
    }
    if (this.values.length >= this.maxValues) {
      this.fail(refetchRequiredSubscriptionError());
      this.release();
      return 'overflow';
    }
    this.values.push(value);
    return 'accepted';
  }

  fail(error: unknown): void {
    if (this.closed || this.error) return;
    this.error = toError(error, 'subscription queue failed');
    this.values.splice(0);
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    this.onReturn();
  }
}
