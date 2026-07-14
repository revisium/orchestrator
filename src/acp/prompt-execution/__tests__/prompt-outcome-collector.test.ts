import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpPromptOutcomeCollector, type AcpStopReason } from '../prompt-outcome-collector.js';

const STOP_REASONS: readonly AcpStopReason[] = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
];

test('collects text in arrival order and completes with a stop reason', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });

  assert.deepEqual(collector.collect({
    kind: 'agent-text',
    sessionId: 'session-1',
    text: 'one',
  }), { outcome: 'accepted' });
  assert.deepEqual(collector.collect({
    kind: 'agent-text',
    sessionId: 'session-1',
    text: ' two',
  }), { outcome: 'accepted' });
  assert.deepEqual(collector.complete({
    sessionId: 'session-1',
    stopReason: 'end_turn',
  }), { outcome: 'accepted' });
  assert.deepEqual(collector.snapshot(), {
    sessionId: 'session-1',
    text: 'one two',
    stopReason: 'end_turn',
    diagnostics: [],
  });
});

test('returns a fresh accepted result for every call', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });

  const first = collector.collect({
    kind: 'agent-text',
    sessionId: 'session-1',
    text: 'one',
  }) as { outcome: string };
  first.outcome = 'mutated';

  assert.deepEqual(collector.collect({
    kind: 'agent-text',
    sessionId: 'session-1',
    text: 'two',
  }), { outcome: 'accepted' });
});

test('rejects every public operation before binding', () => {
  const collector = new AcpPromptOutcomeCollector();
  const expected = new Error('ACP outcome collector is not bound');

  assert.throws(() => collector.collect({
    kind: 'agent-text',
    sessionId: 'session-1',
    text: 'text',
  }), expected);
  assert.throws(() => collector.complete({
    sessionId: 'session-1',
    stopReason: 'end_turn',
  }), expected);
  assert.throws(() => collector.snapshot(), expected);
});

test('rejects binding dependencies more than once', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });

  assert.throws(
    () => collector.bind({ expectedSessionId: 'session-2' }),
    new Error('ACP outcome collector is already bound'),
  );
});

test('preserves normalized diagnostics in arrival order', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  const first = { severity: 'warning' as const, reason: 'first', message: 'First' };
  const second = { severity: 'error' as const, reason: 'second', message: 'Second' };

  collector.collect({ kind: 'diagnostic', sessionId: 'session-1', diagnostic: first });
  collector.collect({ kind: 'diagnostic', sessionId: 'session-1', diagnostic: second });

  assert.deepEqual(collector.snapshot().diagnostics, [first, second]);
});

test('isolates diagnostics from input and returned snapshot mutation', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  const diagnostic = { severity: 'warning' as const, reason: 'stable', message: 'Stable' };

  collector.collect({ kind: 'diagnostic', sessionId: 'session-1', diagnostic });
  const mutableInput = diagnostic as { severity: string; reason: string; message: string };
  mutableInput.reason = 'mutated-input';
  mutableInput.message = 'Mutated input';
  const snapshot = collector.snapshot() as unknown as {
    diagnostics: Array<{ severity: string; reason: string; message: string }>;
  };
  snapshot.diagnostics[0]!.severity = 'mutated-output';
  snapshot.diagnostics[0]!.reason = 'mutated-output';
  snapshot.diagnostics.length = 0;

  assert.deepEqual(collector.snapshot().diagnostics, [{
    severity: 'warning',
    reason: 'stable',
    message: 'Stable',
  }]);
});

test('preserves reported usage and cost', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });

  collector.collect({
    kind: 'usage',
    sessionId: 'session-1',
    used: 7,
    size: 11,
    reportedCost: { amount: 1.25, currency: 'USD' },
  });

  assert.deepEqual(collector.snapshot(), {
    sessionId: 'session-1',
    text: '',
    usage: { used: 7, size: 11 },
    reportedCost: { amount: 1.25, currency: 'USD' },
    diagnostics: [],
  });
});

test('isolates reported usage and cost from input and snapshot mutation', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  const reportedCost = { amount: 2.5, currency: 'EUR' };

  collector.collect({
    kind: 'usage',
    sessionId: 'session-1',
    used: 13,
    size: 21,
    reportedCost,
  });
  reportedCost.amount = 99;
  reportedCost.currency = 'MUT';
  const snapshot = collector.snapshot() as unknown as {
    usage: { used: number; size: number };
    reportedCost: { amount: number; currency: string };
  };
  snapshot.usage.used = 99;
  snapshot.usage.size = 99;
  snapshot.reportedCost.amount = 99;
  snapshot.reportedCost.currency = 'MUT';

  assert.deepEqual(collector.snapshot(), {
    sessionId: 'session-1',
    text: '',
    usage: { used: 13, size: 21 },
    reportedCost: { amount: 2.5, currency: 'EUR' },
    diagnostics: [],
  });
});

test('replaces usage while preserving the last reported cost when omitted', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  collector.collect({
    kind: 'usage',
    sessionId: 'session-1',
    used: 3,
    size: 5,
    reportedCost: { amount: 0.5, currency: 'USD' },
  });

  collector.collect({ kind: 'usage', sessionId: 'session-1', used: 8, size: 13 });

  assert.deepEqual(collector.snapshot(), {
    sessionId: 'session-1',
    text: '',
    usage: { used: 8, size: 13 },
    reportedCost: { amount: 0.5, currency: 'USD' },
    diagnostics: [],
  });
});

test('keeps optional snapshot properties absent before they are reported', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });

  const snapshot = collector.snapshot();

  assert.equal(Object.hasOwn(snapshot, 'usage'), false);
  assert.equal(Object.hasOwn(snapshot, 'reportedCost'), false);
  assert.equal(Object.hasOwn(snapshot, 'stopReason'), false);
});

test('rejects every foreign-session event without changing state', () => {
  const events = [
    { kind: 'agent-text', sessionId: 'foreign', text: 'ignored' },
    {
      kind: 'diagnostic',
      sessionId: 'foreign',
      diagnostic: { severity: 'error', reason: 'ignored', message: 'Ignored' },
    },
    { kind: 'usage', sessionId: 'foreign', used: 99, size: 99 },
    { sessionId: 'foreign', stopReason: 'cancelled' },
  ] as const;

  for (const event of events) {
    const collector = new AcpPromptOutcomeCollector();
    collector.bind({ expectedSessionId: 'session-1' });
    collector.collect({ kind: 'agent-text', sessionId: 'session-1', text: 'kept' });
    const before = collector.snapshot();
    const result = 'kind' in event ? collector.collect(event) : collector.complete(event);

    assert.deepEqual(result, {
      outcome: 'rejected',
      reason: 'foreign-session',
      diagnostics: [{
        severity: 'error',
        reason: 'foreign-session',
        message: 'Outcome event belongs to another session',
      }],
    });
    assert.deepEqual(collector.snapshot(), before);
  }
});

test('rejects a duplicate terminal and preserves the first stop reason', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  collector.complete({ sessionId: 'session-1', stopReason: 'end_turn' });

  const result = collector.complete({ sessionId: 'session-1', stopReason: 'refusal' });

  assert.deepEqual(result, {
    outcome: 'rejected',
    reason: 'duplicate-terminal',
    diagnostics: [{
      severity: 'error',
      reason: 'duplicate-terminal',
      message: 'Prompt outcome is already terminal',
    }],
  });
  assert.equal(collector.snapshot().stopReason, 'end_turn');
});

test('rejects every stream update after terminal without changing state', () => {
  const events = [
    { kind: 'agent-text', sessionId: 'session-1', text: 'ignored' },
    {
      kind: 'diagnostic',
      sessionId: 'session-1',
      diagnostic: { severity: 'error', reason: 'ignored', message: 'Ignored' },
    },
    { kind: 'usage', sessionId: 'session-1', used: 99, size: 99 },
  ] as const;

  for (const event of events) {
    const collector = new AcpPromptOutcomeCollector();
    collector.bind({ expectedSessionId: 'session-1' });
    collector.collect({ kind: 'agent-text', sessionId: 'session-1', text: 'kept' });
    collector.complete({ sessionId: 'session-1', stopReason: 'end_turn' });
    const before = collector.snapshot();

    assert.deepEqual(collector.collect(event), {
      outcome: 'rejected',
      reason: 'update-after-terminal',
      diagnostics: [{
        severity: 'error',
        reason: 'update-after-terminal',
        message: 'Outcome stream event arrived after terminal',
      }],
    });
    assert.deepEqual(collector.snapshot(), before);
  }
});

test('keeps all nested snapshot values isolated together', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  collector.collect({
    kind: 'diagnostic',
    sessionId: 'session-1',
    diagnostic: { severity: 'info', reason: 'stable', message: 'Stable' },
  });
  collector.collect({
    kind: 'usage',
    sessionId: 'session-1',
    used: 5,
    size: 8,
    reportedCost: { amount: 0.25, currency: 'USD' },
  });
  const snapshot = collector.snapshot() as unknown as {
    diagnostics: Array<{ severity: string; reason: string; message: string }>;
    usage: { used: number; size: number };
    reportedCost: { amount: number; currency: string };
  };
  snapshot.diagnostics[0]!.reason = 'mutated';
  snapshot.usage.used = 99;
  snapshot.reportedCost.currency = 'MUT';

  assert.deepEqual(collector.snapshot(), {
    sessionId: 'session-1',
    text: '',
    usage: { used: 5, size: 8 },
    reportedCost: { amount: 0.25, currency: 'USD' },
    diagnostics: [{ severity: 'info', reason: 'stable', message: 'Stable' }],
  });
});

test('returns a fresh rejection and diagnostics for every rejected event', () => {
  const collector = new AcpPromptOutcomeCollector();
  collector.bind({ expectedSessionId: 'session-1' });
  const event = { kind: 'agent-text' as const, sessionId: 'foreign', text: 'ignored' };

  const first = collector.collect(event) as unknown as {
    outcome: string;
    reason: string;
    diagnostics: Array<{ severity: string; reason: string; message: string }>;
  };
  first.outcome = 'mutated';
  first.reason = 'mutated';
  first.diagnostics[0]!.severity = 'mutated';
  first.diagnostics[0]!.reason = 'mutated';
  first.diagnostics[0]!.message = 'mutated';

  assert.deepEqual(collector.collect(event), {
    outcome: 'rejected',
    reason: 'foreign-session',
    diagnostics: [{
      severity: 'error',
      reason: 'foreign-session',
      message: 'Outcome event belongs to another session',
    }],
  });
});

test('preserves every ACP stop reason exactly', () => {
  for (const stopReason of STOP_REASONS) {
    const collector = new AcpPromptOutcomeCollector();
    collector.bind({ expectedSessionId: 'session-1' });
    collector.complete({ sessionId: 'session-1', stopReason });
    assert.equal(collector.snapshot().stopReason, stopReason);
  }
});
