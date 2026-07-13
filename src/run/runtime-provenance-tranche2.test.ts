import test from 'node:test';
import assert from 'node:assert/strict';
import { appendRunAttempt, appendRunCost } from './append-event.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';

function fakeDataAccess(rows: Array<{ rowId: string; data: Record<string, unknown> }>): ControlPlaneDataAccess {
  return {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async () => null,
    createRow: async (table, rowId, data) => {
      rows.push({ rowId, data });
      return { rowId, data };
    },
    updateRow: async (_table, rowId, data) => ({ rowId, data }),
    patchRow: async (_table, rowId, _patches) => ({ rowId, data: {} }),
  };
}

test('attempt and cost persistence stores exact provenance and nullable reported usage', async () => {
  const rows: Array<{ rowId: string; data: Record<string, unknown> }> = [];
  const da = fakeDataAccess(rows);
  const input = {
    runId: 'run-1',
    stepId: 'step-1',
    attemptId: 'attempt-1',
    attemptNo: 1,
    iteration: 0,
    status: 'succeeded',
    runnerId: 'codex',
    provider: 'openai',
    modelId: 'gpt-5.6-luna',
    verdict: 'approved',
    inputTokens: 0,
    outputTokens: null,
    costAmount: null,
    currency: null,
    durationMs: 10,
    output: { ok: true },
  };

  await appendRunAttempt(da, input as unknown as Parameters<typeof appendRunAttempt>[1]);
  await appendRunCost(da, {
    runId: 'run-1',
    stepId: 'step-1',
    stepKey: 'developer',
    attemptId: 'attempt-1',
    cost: {
      runnerId: 'codex',
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
      inputTokens: 0,
      outputTokens: null,
      costAmount: null,
      currency: null,
    },
    index: 0,
  } as unknown as Parameters<typeof appendRunCost>[1]);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]?.data, {
    id: 'attempt-1',
    step_id: 'step-1',
    run_id: 'run-1',
    worker_id: '',
    attempt_no: 1,
    iteration: 0,
    status: 'succeeded',
    idempotency_key: 'attempt-1',
    runner_id: 'codex',
    provider: 'openai',
    model_id: 'gpt-5.6-luna',
    verdict: 'approved',
    input_tokens: 0,
    output_tokens: null,
    cost_amount: null,
    currency: null,
    duration_ms: 10,
    output_summary: '{"ok":true}',
    artifact_ref: '',
    stdout_tail: '',
    stderr_tail: '',
    lesson: '',
    error: '',
    started_at: rows[0]?.data.started_at,
    finished_at: rows[0]?.data.finished_at,
  });
  assert.equal(rows[1]?.data.input_tokens, 0);
  assert.equal(rows[1]?.data.output_tokens, null);
  assert.equal(rows[1]?.data.cost_amount, null);
});

test('attempt and cost persistence reject empty provenance instead of encoding unknown as empty text', async () => {
  const rows: Array<{ rowId: string; data: Record<string, unknown> }> = [];
  const da = fakeDataAccess(rows);
  await assert.rejects(
    () => appendRunAttempt(da, {
      runId: 'run-1',
      stepId: 'step-1',
      attemptId: 'attempt-empty-provenance',
      attemptNo: 1,
      iteration: 0,
      status: 'failed',
      runnerId: '',
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
      verdict: 'BLOCKER',
      inputTokens: null,
      outputTokens: null,
      costAmount: null,
      currency: null,
      durationMs: 0,
      output: null,
    }),
    /runnerId must be a non-empty exact provenance value/,
  );
  assert.equal(rows.length, 0);
});
