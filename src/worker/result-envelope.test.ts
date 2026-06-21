import test from 'node:test';
import assert from 'node:assert/strict';
import {
  agentResultFromStructured,
  parseTransportEnvelope,
  normalizeNextSteps,
} from './result-envelope.js';
import { BASE_STEP } from './test-fixtures.js';

// ─── transport envelope (layer A) ─────────────────────────────────────────────

test('parseTransportEnvelope: extracts text, cost and token usage', () => {
  const stdout = JSON.stringify({
    type: 'result',
    is_error: false,
    result: 'final assistant text',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  const env = parseTransportEnvelope(stdout);
  assert.equal(env.text, 'final assistant text');
  assert.equal(env.isError, false);
  assert.equal(env.costUsd, 0.0123);
  assert.equal(env.inputTokens, 100);
  assert.equal(env.outputTokens, 50);
});

test('parseTransportEnvelope: detects is_error true', () => {
  const stdout = JSON.stringify({ is_error: true, result: 'boom' });
  const env = parseTransportEnvelope(stdout);
  assert.equal(env.isError, true);
  assert.equal(env.text, 'boom');
});

test('parseTransportEnvelope: extracts Claude observability metadata', () => {
  const permissionDenials = [{ tool_name: 'Write', reason: 'denied by policy' }];
  const stdout = JSON.stringify({
    result: 'done',
    permission_denials: permissionDenials,
    terminal_reason: 'permission_denied',
    session_id: 'session-123',
  });

  const env = parseTransportEnvelope(stdout);
  assert.equal(env.text, 'done');
  assert.deepEqual(env.permissionDenials, permissionDenials);
  assert.equal(env.terminalReason, 'permission_denied');
  assert.equal(env.sessionId, 'session-123');
});

test('parseTransportEnvelope: throws on non-JSON stdout', () => {
  assert.throws(
    () => parseTransportEnvelope('not json at all'),
    /transport envelope/,
  );
});

test('parseTransportEnvelope: throws on non-object JSON', () => {
  assert.throws(() => parseTransportEnvelope('"just a string"'), /transport envelope/);
});

test('agentResultFromStructured: requires top-level verdict and string output', () => {
  const result = agentResultFromStructured({ verdict: 'approved', output: '# Plan' });
  assert.equal(result.verdict, 'approved');
  assert.equal(result.output, '# Plan');

  assert.throws(
    () => agentResultFromStructured({ output: '# Plan' }),
    /missing required top-level verdict/,
  );
  assert.throws(
    () => agentResultFromStructured({ verdict: '', output: '# Plan' }),
    /missing required top-level verdict/,
  );
  assert.throws(
    () => agentResultFromStructured({ verdict: 'approved', output: { summary: 'nope' } }),
    /missing required string output/,
  );
  assert.throws(
    () => agentResultFromStructured({ verdict: 'approved', output: '# Plan', nextSteps: { role: 'developer' } }),
    /nextSteps must be an array/,
  );
});

// ─── nextSteps normalization ──────────────────────────────────────────────────

test('normalizeNextSteps: defaults taskId and modelProfile from the step', () => {
  const specs = normalizeNextSteps(
    [{ role: 'developer', kind: 'implement', input: { from: 'x' } }],
    BASE_STEP,
  );
  assert.equal(specs.length, 1);
  assert.equal(specs[0]?.taskId, BASE_STEP.taskId);
  assert.equal(specs[0]?.modelProfile, BASE_STEP.modelProfile);
  assert.equal(specs[0]?.role, 'developer');
  assert.equal(specs[0]?.kind, 'implement');
});

test('normalizeNextSteps: passes through optional fields and honours explicit taskId/profile', () => {
  const specs = normalizeNextSteps(
    [
      {
        role: 'reviewer',
        kind: 'review',
        input: null,
        taskId: 'task-other',
        modelProfile: 'deep',
        priority: 5,
        maxAttempts: 2,
        dependsOn: ['step-a'],
        runAfter: '2026-01-01T00:00:00.000Z',
      },
    ],
    BASE_STEP,
  );
  const spec = specs[0];
  assert.equal(spec?.taskId, 'task-other');
  assert.equal(spec?.modelProfile, 'deep');
  assert.equal(spec?.priority, 5);
  assert.equal(spec?.maxAttempts, 2);
  assert.deepEqual(spec?.dependsOn, ['step-a']);
  assert.equal(spec?.runAfter, '2026-01-01T00:00:00.000Z');
});

test('normalizeNextSteps: throws naming the index when role is missing', () => {
  assert.throws(
    () => normalizeNextSteps([{ kind: 'implement', input: null }], BASE_STEP),
    /nextSteps\[0\] missing required "role"/,
  );
});

test('normalizeNextSteps: throws when input is absent', () => {
  assert.throws(
    () => normalizeNextSteps([{ role: 'developer', kind: 'implement' }], BASE_STEP),
    /nextSteps\[0\] missing required "input"/,
  );
});
