import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';

type RunDetail = Awaited<ReturnType<TaskControlPlaneApiService['getRun']>>;

/** Flatten every step across a run's tasks. */
export function allSteps(detail: RunDetail) {
  return detail.tasks.flatMap((task) => task.steps);
}

/** Poll until the run settles (terminal or parked at a gate). Returns the wait state. */
export function waitState(api: TaskControlPlaneApiService, runId: string, timeoutMs = 60_000) {
  return api.waitForRun({ runId, timeoutMs, intervalMs: 500 });
}

/** Wait until the run parks at a gate; assert it is a gate (optionally a specific topic). */
export async function waitForGate(
  api: TaskControlPlaneApiService,
  runId: string,
  expectedTopic?: 'plan' | 'merge',
): Promise<{ inboxId: string; topic: string }> {
  const state = await api.waitForRun({ runId, timeoutMs: 60_000, intervalMs: 500 });
  assert.equal(state.state, 'pending_gate', `expected pending_gate, got ${state.state}`);
  const inbox = state.inbox;
  assert.ok(inbox, 'pending_gate must include the inbox item to resolve');
  const context = inbox.context;
  assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
  const topic = (context as Record<string, unknown>)['topic'];
  assert.equal(typeof topic, 'string');
  if (expectedTopic) assert.equal(topic, expectedTopic, `expected ${expectedTopic} gate, got ${String(topic)}`);
  return { inboxId: inbox.id, topic: topic as string };
}

/**
 * Drive a gated run to a terminal state by approving each gate as it opens.
 * Returns the terminal `state` plus the ordered list of approved gate topics (e.g. `['plan','merge']`).
 */
export async function approveUntilTerminal(
  api: TaskControlPlaneApiService,
  runId: string,
): Promise<{ state: string; approvedTopics: string[] }> {
  const approvedTopics: string[] = [];
  for (;;) {
    const state = await api.waitForRun({ runId, timeoutMs: 60_000, intervalMs: 500 });
    if (state.state !== 'pending_gate') return { state: state.state, approvedTopics };
    const inbox = state.inbox;
    assert.ok(inbox, 'pending_gate must include the inbox item to resolve');
    const context = inbox.context;
    assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
    const topic = (context as Record<string, unknown>)['topic'];
    assert.equal(typeof topic, 'string');
    approvedTopics.push(topic as string);
    await api.approveGate({ inboxId: inbox.id, resolvedBy: 'e2e' });
  }
}
