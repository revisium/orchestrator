import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  givenFeatureRunAtPlanGate,
  givenFeatureRunAtMergeGate,
  createTargetRepo,
  waitState,
  approveUntilTerminal,
  executedRoles,
} from './kit/index.js';

// Group B — human-in-the-loop gates (plan / merge). One real host per file; isolated by runId.
let h: RunHarness;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

const hasCode = (code: string) => (err: unknown): boolean => (err as { code?: string }).code === code;

test('B9: gate ops on an unknown inbox id reject with ROW_NOT_FOUND', { skip: e2eSkip }, async () => {
  await assert.rejects(() => h.api.approveGate({ inboxId: 'inbox_missing' }), hasCode('ROW_NOT_FOUND'));
  await assert.rejects(() => h.api.rejectGate({ inboxId: 'inbox_missing' }), hasCode('ROW_NOT_FOUND'));
  await assert.rejects(() => h.api.getInboxItem('inbox_missing'), hasCode('ROW_NOT_FOUND'));
});

test('B3: plan-gate reject blocks the run (data-routed terminal); developer never executes', { skip: e2eSkip }, async () => {
  // SPEC-CORRECT DIFFERENCE (plan 0015 slice 3): the old hardcoded engine HARD-CANCELLED the run on a
  // plan-gate reject. The data-driven engine routes the gate verdict purely through the template (§8):
  // feature-development's planGate declares outcome [approved] with a default → `blockedEnd`, so a
  // reject (no `approved`) falls through to the BLOCKED terminal. `cancelled` is not a core terminal
  // status (succeeded|failed|blocked) — blocked is the faithful data-routed mapping. The invariant the
  // test pins is unchanged: a rejected plan gate stops the run BEFORE the developer executes.
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    const res = await h.api.rejectGate({ inboxId, resolvedBy: 'e2e' });
    assert.equal(res.topic, 'plan');

    await waitState(h.api, runId); // workflow returns after routing to the blocked terminal
    // waitForRun reports `blocked` as soon as the pipeline_blocked event is visible; the run-row status
    // patch lags it, so poll briefly for the run row to settle off `running` rather than reading once.
    let detail = await h.api.getRun({ runId, includeEvents: true, includeLog: true });
    for (let waited = 0; waited < 5_000 && detail.run.status === 'running'; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      detail = await h.api.getRun({ runId, includeEvents: true, includeLog: true });
    }
    assert.notEqual(detail.run.status, 'running', 'the rejected-plan run must settle, not hang in running (no false pass on timeout)');
    assert.notEqual(detail.run.status, 'completed', 'a rejected plan gate must not complete the run');
    assert.ok(
      !executedRoles(h, runId).some(([role]) => role === 'developer'),
      'developer must not run when the plan gate is rejected',
    );
  } finally {
    target.cleanup();
  }
});

test('B4: merge-gate reject completes the run (does not cancel)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtMergeGate(h, target);
    const res = await h.api.rejectGate({ inboxId, resolvedBy: 'e2e' });
    assert.equal(res.topic, 'merge');

    await waitState(h.api, runId);
    const detail = await h.api.getRun({ runId });
    assert.equal(detail.run.status, 'completed', 'merge reject completes the run (see fix #53)');
  } finally {
    target.cleanup();
  }
});

test('B5: approving an already-resolved gate is idempotent (stored answer)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    const first = await h.api.approveGate({ inboxId, resolvedBy: 'e2e' });
    assert.equal(first.signaled, true);

    const second = await h.api.approveGate({ inboxId, resolvedBy: 'e2e' });
    assert.equal(second.signaled, true);
    assert.equal(second.previousStatus, 'resolved', 'second approve sees an already-resolved inbox');
    assert.deepEqual(second.answer, first.answer, 'same stored answer is replayed');

    const terminal = await approveUntilTerminal(h.api, runId); // approve merge
    assert.equal(terminal.state, 'completed');
  } finally {
    target.cleanup();
  }
});

test('B6: reject after approve keeps the first decision (approve wins)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    await h.api.approveGate({ inboxId, resolvedBy: 'e2e' });
    const rej = await h.api.rejectGate({ inboxId, resolvedBy: 'e2e' });
    assert.equal(rej.previousStatus, 'resolved');
    assert.equal((rej.answer as { decision?: string }).decision, 'approve', 'first decision wins; no re-decide');

    const terminal = await approveUntilTerminal(h.api, runId);
    assert.equal(terminal.state, 'completed');
  } finally {
    target.cleanup();
  }
});

test('B7: answerQuestion on a gate is rejected (must use approve/reject)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    await assert.rejects(
      () => h.api.answerQuestion({ inboxId, answer: { note: 'not allowed' } }),
      hasCode('VALIDATION_FAILURE'),
    );
    await approveUntilTerminal(h.api, runId); // leave the run terminal
  } finally {
    target.cleanup();
  }
});

test('B10: a parked gate is visible via pending decisions and risk summary', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    const pending = await h.api.getPendingDecisions(runId);
    assert.ok(pending.some((i) => i.id === inboxId), 'plan gate appears in pending decisions');

    const risk = await h.api.summarizeGateRisk(inboxId);
    assert.equal(risk.topic, 'plan');
    assert.equal(risk.kind, 'approval');

    await approveUntilTerminal(h.api, runId);
  } finally {
    target.cleanup();
  }
});

test('B13: a parked plan gate carries the plan artifact + reviewer verdict inline (D3)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    const item = await h.api.getInboxItem(inboxId);
    const ctx = item.context as {
      topic?: string;
      summary?: {
        nodeId?: string;
        gatedArtifact?: { nodeId?: string; name?: string; payload?: unknown; preview?: string };
        reviewerVerdict?: unknown;
      };
    };

    assert.equal(ctx.topic, 'plan');
    assert.ok(ctx.summary, 'gate carries a summary');
    assert.equal(ctx.summary.nodeId, 'planGate');
    // D3: the analyst's plan is inline on the gate row — an approver decides without a get_agent_attempts dig.
    assert.ok(ctx.summary.gatedArtifact, 'plan artifact is inline on the gate');
    assert.equal(ctx.summary.gatedArtifact.nodeId, 'analyst');
    assert.equal(ctx.summary.gatedArtifact.name, 'plan');
    assert.ok(
      ctx.summary.gatedArtifact.payload !== undefined || ctx.summary.gatedArtifact.preview !== undefined,
      'the plan payload (or a head preview when over budget) is present',
    );
    // D3: the reviewer verdict is inline (defaulted to the routing verdict that opened the gate).
    assert.ok(ctx.summary.reviewerVerdict, 'reviewer verdict is inline on the gate');

    await approveUntilTerminal(h.api, runId);
  } finally {
    target.cleanup();
  }
});

test('B12: cancelling a run parked at a gate marks it cancelled', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId, inboxId } = await givenFeatureRunAtPlanGate(h, target);
    await h.api.cancelRun(runId);

    const detail = await h.api.getRun({ runId });
    assert.equal(detail.run.status, 'cancelled');

    // Hypothesis H-CancelGate: cancelRun does not signal DBOS, so the workflow stays parked.
    // Resolve the gate to unpark and settle it, keeping the shared harness clean.
    await h.api.rejectGate({ inboxId, resolvedBy: 'e2e' }).catch(() => undefined);
    await waitState(h.api, runId).catch(() => undefined);
  } finally {
    target.cleanup();
  }
});
