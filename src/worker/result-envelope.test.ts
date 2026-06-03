import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REVO_RESULT_CONTRACT,
  parseTransportEnvelope,
  extractAgentResult,
  normalizeNextSteps,
} from './result-envelope.js';
import { BASE_STEP } from './test-fixtures.js';

function agentBlock(obj: unknown): string {
  return `Here is my plan.\n<<<REVO_RESULT\n${JSON.stringify(obj)}\nREVO_RESULT>>>\n`;
}

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

test('parseTransportEnvelope: throws on non-JSON stdout', () => {
  assert.throws(
    () => parseTransportEnvelope('not json at all'),
    /transport envelope/,
  );
});

test('parseTransportEnvelope: throws on non-object JSON', () => {
  assert.throws(() => parseTransportEnvelope('"just a string"'), /transport envelope/);
});

// ─── agent envelope (layer B) ─────────────────────────────────────────────────

test('extractAgentResult: parses a valid REVO_RESULT block', () => {
  const text = agentBlock({
    output: { summary: 'did the thing' },
    artifacts: { planPath: 'docs/plans/0099.md' },
    nextSteps: [{ role: 'developer', kind: 'implement', input: { from: 'step-1' } }],
    needsHuman: false,
    lesson: null,
  });

  const result = extractAgentResult(text);
  assert.deepEqual(result.output, { summary: 'did the thing' });
  assert.deepEqual(result.artifacts, { planPath: 'docs/plans/0099.md' });
  assert.equal(result.nextSteps.length, 1);
  assert.equal(result.needsHuman, false);
  assert.equal(result.lesson, undefined); // null lesson → undefined
});

test('extractAgentResult: reads needsHuman true', () => {
  const text = agentBlock({ output: 'blocked', nextSteps: [], needsHuman: true });
  const result = extractAgentResult(text);
  assert.equal(result.needsHuman, true);
  assert.deepEqual(result.nextSteps, []);
});

test('extractAgentResult: throws the documented lesson when the block is absent', () => {
  assert.throws(
    () => extractAgentResult('I forgot to emit the block.'),
    /agent did not emit a parseable REVO_RESULT envelope/,
  );
});

test('extractAgentResult: throws when the block JSON is unparseable', () => {
  const text = '<<<REVO_RESULT\n{ not valid json }\nREVO_RESULT>>>';
  assert.throws(
    () => extractAgentResult(text),
    /agent did not emit a parseable REVO_RESULT envelope/,
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

// ─── marker-sync guard ────────────────────────────────────────────────────────
// Replace the placeholder body inside REVO_RESULT_CONTRACT with valid JSON, KEEPING the markers
// exactly as the constant defines them, then prove the parser finds and parses the block. This fails
// loudly if the runner-appended contract's markers ever drift from the parser's markers.

test('marker-sync: REVO_RESULT_CONTRACT markers match what the parser extracts', () => {
  const open = '<<<REVO_RESULT';
  const close = 'REVO_RESULT>>>';
  assert.ok(REVO_RESULT_CONTRACT.includes(open), 'contract must contain the open marker');
  assert.ok(REVO_RESULT_CONTRACT.includes(close), 'contract must contain the close marker');

  const startIdx = REVO_RESULT_CONTRACT.indexOf(open);
  const endIdx = REVO_RESULT_CONTRACT.indexOf(close);
  const validBody = JSON.stringify({
    output: 'ok',
    nextSteps: [{ role: 'developer', kind: 'implement', input: { from: 'step-1' } }],
    needsHuman: false,
    lesson: null,
  });
  const fixture =
    REVO_RESULT_CONTRACT.slice(0, startIdx + open.length) +
    '\n' + validBody + '\n' +
    REVO_RESULT_CONTRACT.slice(endIdx);

  const result = extractAgentResult(fixture);
  assert.equal(result.needsHuman, false);
  assert.equal(result.nextSteps.length, 1);
  const specs = normalizeNextSteps(result.nextSteps, BASE_STEP);
  assert.equal(specs[0]?.role, 'developer');
});
