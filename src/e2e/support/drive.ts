import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';

// A fast poll can observe a run as terminal before it has settled: completeRun/failRun patch the
// run row INSIDE the workflow's final step, so the row turns terminal while the DBOS workflow
// status still reads PENDING (and the last step's events/attempts are mid-commit). Rather than
// polling slowly to make that window unlikely (the old 500ms interval), poll fast and return only
// SETTLED states — a wait state nothing about which can still change:
// - pending_gate / question: the inbox row to resolve is already visible;
// - cancelled: settled by run row alone — cancelRun deliberately does not signal DBOS, the parked
//   workflow outlives the row (pinned by gates.e2e H-CancelGate);
// - completed / failed / blocked: the DBOS workflow status is terminal too, which implies every
//   step write the workflow performs has committed.
// The timeout stays a deliberate stuck-detector: the heaviest runs (crash-recovery, seeded
// plan→merge) need ~10s+ on a loaded CI runner, so 30s; an unsettled state at the deadline is
// returned as-is and the caller's assertion fails loud.
const POLL_MS = 25;
const WAIT_TIMEOUT_MS = 30_000;
const TERMINAL_WORKFLOW_STATUSES = new Set(['SUCCESS', 'ERROR', 'CANCELLED']);

type WaitedState = Awaited<ReturnType<TaskControlPlaneApiService['waitForRun']>>;

function settled(state: WaitedState): boolean {
  if (state.state === 'pending_gate' || state.state === 'question') return true;
  if (state.state === 'cancelled') return true;
  return TERMINAL_WORKFLOW_STATUSES.has(state.workflowStatus);
}

/** Poll until the run settles (terminal or parked at a gate). Returns the wait state. */
export async function waitState(
  api: TaskControlPlaneApiService,
  runId: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<WaitedState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const state = await api.waitForRun({ runId, timeoutMs: remaining, intervalMs: POLL_MS });
    if (settled(state) || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Wait until the run parks at a gate; assert it is a gate (optionally a specific topic). */
export async function waitForGate(
  api: TaskControlPlaneApiService,
  runId: string,
  expectedTopic?: 'plan' | 'merge' | 'question' | 'retry',
): Promise<{ inboxId: string; topic: string; context: Record<string, unknown>; options: string[] }> {
  const state = await waitState(api, runId);
  assert.equal(state.state, 'pending_gate', `expected pending_gate, got ${state.state}`);
  const inbox = state.inbox;
  assert.ok(inbox, 'pending_gate must include the inbox item to resolve');
  const context = inbox.context;
  assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
  const topic = (context as Record<string, unknown>)['topic'];
  assert.equal(typeof topic, 'string');
  if (expectedTopic) assert.equal(topic, expectedTopic, `expected ${expectedTopic} gate, got ${String(topic)}`);
  return { inboxId: inbox.id, topic: topic as string, context: context as Record<string, unknown>, options: inbox.options };
}

export type ExpectedGate = Readonly<{
  topic: 'plan' | 'merge' | 'question' | 'retry';
  options: readonly string[];
}>;

export type ExpectedGateResolution = ExpectedGate & Readonly<{
  outcome: string;
}>;

export async function waitForExpectedGate(
  api: TaskControlPlaneApiService,
  runId: string,
  expected: ExpectedGate | ExpectedGateResolution,
): Promise<{ inboxId: string; topic: string; context: Record<string, unknown>; options: string[] }> {
  const gate = await waitForGate(api, runId, expected.topic);
  assert.deepEqual(gate.options, expected.options, `unexpected ${expected.topic} gate options`);
  if ('outcome' in expected) {
    assert.ok(
      expected.options.includes(expected.outcome),
      `outcome ${expected.outcome} is not available for ${expected.topic} gate`,
    );
  }
  return gate;
}

export async function resolveExpectedGate(
  api: TaskControlPlaneApiService,
  runId: string,
  expected: ExpectedGateResolution,
): Promise<void> {
  const gate = await waitForExpectedGate(api, runId, expected);
  await api.resolveGate({ inboxId: gate.inboxId, outcome: expected.outcome, resolvedBy: 'e2e' });
}

export async function resolveGateSequence(
  api: TaskControlPlaneApiService,
  runId: string,
  sequence: readonly ExpectedGateResolution[],
): Promise<{ state: string; resolvedTopics: string[] }> {
  const resolvedTopics: string[] = [];
  for (const expected of sequence) {
    resolvedTopics.push(expected.topic);
    await resolveExpectedGate(api, runId, expected);
  }

  const terminal = await waitState(api, runId);
  if (terminal.state === 'pending_gate') {
    const topic = terminal.inbox?.context && typeof terminal.inbox.context === 'object'
      ? (terminal.inbox.context as Record<string, unknown>)['topic']
      : undefined;
    throw new Error(`unexpected additional gate ${String(topic)}`);
  }
  return { state: terminal.state, resolvedTopics };
}
