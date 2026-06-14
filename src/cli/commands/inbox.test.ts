/**
 * Unit tests for src/cli/commands/inbox.ts — CLI gate-resolve branching (C4, 0004 review).
 *
 * Tests the exported `resolveInboxCommand` with fake InboxResolveDeps, exercising the
 * real CLI branching logic without NestJS or DBOS.
 *
 * Coverage:
 *   (a) GATE row (kind='approval', runId, context.topic='plan') + --approve
 *       → calls resolveInbox then signal(runId, 'plan', <stored answer>, id)
 *       → asserts STORED answer is signaled (G2), not the raw flag
 *   (b) --approve/--reject on a NON-gate row → errors, no signal
 *   (c) Unknown id → "not found", no resolve/signal
 *
 * Does NOT test the NestJS/DBOS wiring (that is integration-level); only the branching.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveInboxCommand } from './inbox.js';
import type { InboxResolveDeps } from './inbox.js';
import type { InboxItem } from '../../control-plane/inbox.js';
import type { PollOpts } from './poll-workflow-state.js';

// ─── helpers ────────────────────────────────────────────────────────────────

type SignalCall = { workflowId: string; topic: string; payload: unknown; idempotencyKey: string };
type ResolveCall = { itemId: string; answer: unknown; resolvedBy: string };
type PollCall = { runId: string; pollOpts?: PollOpts };

function makeGateRow(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox_gate_001',
    kind: 'approval',
    runId: 'run-plan-1',
    taskId: '',
    stepId: '',
    projectId: '',
    title: 'Plan approval',
    context: { topic: 'plan', summary: { arch: 'monolith' } },
    options: ['approve', 'reject'],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-08T10:00:00.000Z',
    resolvedAt: '',
    ...overrides,
  };
}

function makeQuestionRow(): InboxItem {
  return {
    id: 'inbox_q_001',
    kind: 'question',
    runId: '',
    taskId: '',
    stepId: '',
    projectId: '',
    title: 'A question',
    context: null,
    options: [],
    status: 'pending',
    answer: null,
    resolvedBy: '',
    createdAt: '2026-06-08T10:00:00.000Z',
    resolvedAt: '',
  };
}

function makeDeps(
  row: InboxItem | null,
  storedAnswer: unknown = { decision: 'approve' },
  alreadyResolved = false,
): {
  deps: InboxResolveDeps;
  signalCalls: SignalCall[];
  resolveCalls: ResolveCall[];
  pollCalls: PollCall[];
} {
  const signalCalls: SignalCall[] = [];
  const resolveCalls: ResolveCall[] = [];
  const pollCalls: PollCall[] = [];

  const deps: InboxResolveDeps = {
    getInbox: async () => row,
    resolveInbox: async (itemId, answer, resolvedBy) => {
      resolveCalls.push({ itemId, answer, resolvedBy });
      return { status: alreadyResolved ? ('resolved' as const) : ('pending' as const), answer: storedAnswer };
    },
    signal: async (workflowId, topic, payload, idempotencyKey) => {
      signalCalls.push({ workflowId, topic, payload, idempotencyKey });
    },
    pollRunState: async (runId, pollOpts) => {
      pollCalls.push({ runId, pollOpts });
    },
  };

  return { deps, signalCalls, resolveCalls, pollCalls };
}

// ─── (a) GATE row + --approve ────────────────────────────────────────────────

test('C4(a): gate row + --approve calls resolveInbox then signals stored answer (G2)', async () => {
  const gateRow = makeGateRow();
  const storedAnswer = { decision: 'approve' };
  const { deps, signalCalls, resolveCalls } = makeDeps(gateRow, storedAnswer);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false, by: 'alice' }, deps);
    assert.equal(ok, true, 'resolveInboxCommand must return true on success');
    assert.equal(resolveCalls.length, 1, 'resolveInbox must be called once');
    assert.equal(resolveCalls[0]?.itemId, 'inbox_gate_001');
    assert.equal(resolveCalls[0]?.resolvedBy, 'alice');

    // C4/G2: signal must be called with the STORED answer, not the raw flag.
    assert.equal(signalCalls.length, 1, 'signal must be called once on gate approve');
    const call = signalCalls[0];
    assert.ok(call, 'signal call must exist');
    // G9 canonical order: signal(workflowId, topic, payload, idempotencyKey).
    assert.equal(call.workflowId, 'run-plan-1', 'signal workflowId must be the runId');
    assert.equal(call.topic, 'plan', 'signal topic must be the gate topic from context');
    assert.deepEqual(call.payload, storedAnswer, 'signal payload must be the STORED answer (C4/G2)');
    assert.equal(call.idempotencyKey, 'inbox_gate_001', 'signal idempotencyKey must be the inbox id');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(a): gate row + --reject calls resolveInbox then signals stored reject answer', async () => {
  const gateRow = makeGateRow();
  const storedAnswer = { decision: 'reject' };
  const { deps, signalCalls, resolveCalls } = makeDeps(gateRow, storedAnswer);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('inbox_gate_001', { approve: false, reject: true, by: 'bob' }, deps);
    assert.equal(ok, true);
    assert.equal(resolveCalls.length, 1);
    assert.equal(signalCalls.length, 1);
    assert.deepEqual(signalCalls[0]?.payload, storedAnswer, 'stored reject answer signaled (C4/G2)');
    assert.equal(signalCalls[0]?.topic, 'plan', 'topic must be plan from context');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(a): gate row already-resolved → signals STORED answer, prints already-resolved note', async () => {
  const gateRow = makeGateRow({ status: 'resolved', answer: { decision: 'approve' } });
  const storedAnswer = { decision: 'approve' };
  const { deps, signalCalls } = makeDeps(gateRow, storedAnswer, true /* alreadyResolved */);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(String(args[0]));
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false }, deps);
    assert.ok(logs.some((l) => l.includes('already resolved')), 'must print already-resolved note');
    // Still signals (idempotency key collapses in DBOS.send):
    assert.equal(signalCalls.length, 1, 'signal must still be called on already-resolved (idempotent path)');
    assert.deepEqual(signalCalls[0]?.payload, storedAnswer, 'stored answer signaled even on re-resolve');
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(a): gate row polls run state after signal', async () => {
  const gateRow = makeGateRow();
  const { deps, pollCalls } = makeDeps(gateRow);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false }, deps);
    assert.equal(pollCalls.length, 1, 'pollRunState must be called once after signal');
    assert.equal(pollCalls[0]?.runId, 'run-plan-1', 'pollRunState called with the runId');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(a): merge gate signals only and lets the workflow own completion', async () => {
  const gateRow = makeGateRow({
    runId: 'run-merge-1',
    title: 'Merge approval',
    context: { topic: 'merge', summary: { prUrl: 'stub://pr/placeholder' } },
  });
  const { deps, signalCalls, pollCalls } = makeDeps(gateRow, { decision: 'approve' });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false, wait: true }, deps);
    assert.deepEqual(signalCalls.map((call) => [call.workflowId, call.topic]), [['run-merge-1', 'merge']]);
    assert.equal(pollCalls.length, 1, 'pollRunState still runs after gate signal');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── 0006: --wait threading on inbox resolve ─────────────────────────────────

test('0006: inbox resolve --approve --wait → pollRunState receives {wait:true}', async () => {
  const gateRow = makeGateRow();
  const { deps, pollCalls } = makeDeps(gateRow);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false, wait: true }, deps);
    assert.equal(pollCalls.length, 1, 'pollRunState must be called once');
    assert.equal(pollCalls[0]?.pollOpts?.wait, true, '--wait must set wait:true in PollOpts');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('0006: inbox resolve --approve (no --wait) → pollRunState receives {wait:false}', async () => {
  const gateRow = makeGateRow();
  const { deps, pollCalls } = makeDeps(gateRow);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false, wait: false }, deps);
    assert.equal(pollCalls.length, 1, 'pollRunState must be called once');
    assert.equal(pollCalls[0]?.pollOpts?.wait, false, 'no --wait must set wait:false in PollOpts');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── (b) --approve/--reject on a NON-gate row ────────────────────────────────

test('C4(b): --approve on a question row → errors, no signal, no resolve', async () => {
  const questionRow = makeQuestionRow();
  const { deps, signalCalls, resolveCalls } = makeDeps(questionRow);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('inbox_q_001', { approve: true, reject: false }, deps);
    assert.equal(ok, false, 'must return false on non-gate approve error');
    assert.equal(process.exitCode, 1, 'exit code must be 1');
    assert.equal(signalCalls.length, 0, 'signal must NOT be called on non-gate row');
    assert.equal(resolveCalls.length, 0, 'resolveInbox must NOT be called when erroring on non-gate');
    assert.ok(errors.some((e) => e.toLowerCase().includes('gate') || e.includes('--approve')), 'error must mention gate or approve');
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(b): --reject on a question row → errors, no signal', async () => {
  const questionRow = makeQuestionRow();
  const { deps, signalCalls, resolveCalls } = makeDeps(questionRow);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('inbox_q_001', { approve: false, reject: true }, deps);
    assert.equal(process.exitCode, 1, 'exit code must be 1');
    assert.equal(signalCalls.length, 0, 'signal must NOT be called on non-gate reject');
    assert.equal(resolveCalls.length, 0, 'resolveInbox must NOT be called when erroring on non-gate');
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(b): approval row without topic + --approve → treated as non-gate, errors', async () => {
  // An approval kind row without context.topic is NOT a gate row per isGateRow.
  const approvalNoTopic: InboxItem = {
    ...makeGateRow(),
    context: { summary: 'some data' }, // no topic key
  };
  const { deps, signalCalls, resolveCalls } = makeDeps(approvalNoTopic);
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('inbox_gate_001', { approve: true, reject: false }, deps);
    assert.equal(ok, false, 'must fail: no topic means not a gate row');
    assert.equal(signalCalls.length, 0, 'no signal for non-gate');
    assert.equal(resolveCalls.length, 0, 'no resolve when erroring');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── (c) Unknown / missing id ────────────────────────────────────────────────

test('C4(c): unknown id → "not found" error, no resolve, no signal', async () => {
  const { deps, signalCalls, resolveCalls } = makeDeps(null /* row not found */);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('bad_id', { approve: true, reject: false }, deps);
    assert.equal(ok, false, 'must return false when row not found');
    assert.equal(process.exitCode, 1, 'exit code must be 1 when not found');
    assert.ok(errors.some((e) => e.includes('not found')), 'error must mention not found');
    assert.equal(resolveCalls.length, 0, 'resolveInbox must NOT be called when row is missing');
    assert.equal(signalCalls.length, 0, 'signal must NOT be called when row is missing');
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('C4(c): unknown id with --answer → "not found" error, no resolve, no signal', async () => {
  const { deps, signalCalls, resolveCalls } = makeDeps(null);
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await resolveInboxCommand('bad_id', { approve: false, reject: false, answer: 'yes' }, deps);
    assert.equal(process.exitCode, 1, 'exit code must be 1 when not found');
    assert.ok(errors.some((e) => e.includes('not found')));
    assert.equal(resolveCalls.length, 0);
    assert.equal(signalCalls.length, 0);
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── non-gate --answer path (preserved 0002 behavior) ────────────────────────

test('C4: non-gate --answer path resolves without signal', async () => {
  const questionRow = makeQuestionRow();
  const { deps, signalCalls, resolveCalls } = makeDeps(questionRow, 'yes');
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const ok = await resolveInboxCommand('inbox_q_001', { approve: false, reject: false, answer: 'yes' }, deps);
    assert.equal(ok, true, 'non-gate --answer resolve must succeed');
    assert.equal(resolveCalls.length, 1, 'resolveInbox called once');
    assert.equal(resolveCalls[0]?.answer, 'yes', 'answer forwarded to resolveInbox');
    assert.equal(signalCalls.length, 0, 'signal must NOT be called on non-gate path');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});
