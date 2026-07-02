import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';

// Poll at 500ms: tighter intervals can observe a run as terminal before its DBOS workflow status /
// step-status cascade settle, flaking `workflowStatus`/`no ready steps` assertions on slower CI.
// A real stubbed run settles in a few seconds locally, but the whole suite runs sequentially against
// one process-global DBOS host + embedded Postgres, so the heaviest runs (crash-recovery, seeded
// plan→merge) can take ~10s+ on a loaded CI runner. 30s keeps a fail-fast stuck-detector margin while
// tolerating that latency; the underlying e2e slowness is tracked as a separate speed-up task.
const POLL_MS = 500;
const WAIT_TIMEOUT_MS = 30_000;

/** Poll until the run settles (terminal or parked at a gate). Returns the wait state. */
export function waitState(api: TaskControlPlaneApiService, runId: string, timeoutMs = WAIT_TIMEOUT_MS) {
  return api.waitForRun({ runId, timeoutMs, intervalMs: POLL_MS });
}

/** Wait until the run parks at a gate; assert it is a gate (optionally a specific topic). */
export async function waitForGate(
  api: TaskControlPlaneApiService,
  runId: string,
  expectedTopic?: 'plan' | 'merge',
): Promise<{ inboxId: string; topic: string }> {
  const state = await api.waitForRun({ runId, timeoutMs: WAIT_TIMEOUT_MS, intervalMs: POLL_MS });
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
    const state = await api.waitForRun({ runId, timeoutMs: WAIT_TIMEOUT_MS, intervalMs: POLL_MS });
    if (state.state !== 'pending_gate') return { state: state.state, approvedTopics };
    const inbox = state.inbox;
    assert.ok(inbox, 'pending_gate must include the inbox item to resolve');
    const context = inbox.context;
    assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
    const topic = (context as Record<string, unknown>)['topic'];
    assert.equal(typeof topic, 'string');
    approvedTopics.push(topic as string);
    await api.resolveGate({ inboxId: inbox.id, outcome: 'approved', resolvedBy: 'e2e' });
  }
}
