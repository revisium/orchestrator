import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  startLocalChangeRun,
  startStubbedFeatureRun,
  createTargetRepo,
  type TargetRepo,
  waitState,
  waitForGate,
  approveUntilTerminal,
} from './kit/index.js';

// Group J — CONCURRENCY. The dev-tasks queue runs up to REVO_DEV_TASKS_CONCURRENCY (8 under
// test:e2e) workflows at once; excess runs queue and drain as slots free. All runs share ONE
// mutable Revisium draft, so the safety net here is: the queue never drops a run, concurrent runs
// never cross-contaminate each other's durable state, a double-start runs the workflow once, and
// gates/terminal verbs of different runs resolve independently. One shared host; runs are launched
// concurrently with Promise.all.
//
// NOT covered (documented gap): two CONCURRENT runs against the SAME target repo are unsafe — the
// integrator shares one working tree (no worktree isolation yet, a deferred feature), so real git
// ops race. That is a real-git timing race, not a behaviour we can mock; an e2e for it must wait
// for worktree isolation. Every test here uses a distinct repo (or the stub integrator).

let h: RunHarness;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

/** Count a run's events of a given type (server-filtered by run_id → also proves isolation). */
async function countEvents(runId: string, type: string): Promise<number> {
  const events = await h.api.getRunEvents({ runId, limit: 100 });
  return events.filter((e) => e.type === type).length;
}

test('J1: more runs than the queue concurrency limit all complete (none dropped)', { skip: e2eSkip }, async () => {
  const N = 10; // > REVO_DEV_TASKS_CONCURRENCY (8) → some runs must queue, then all must drain
  const runs = await Promise.all(Array.from({ length: N }, () => startLocalChangeRun(h)));
  assert.equal(new Set(runs.map((r) => r.runId)).size, N, 'each enqueued run is distinct');
  for (const run of runs) {
    const state = await waitState(h.api, run.runId);
    assert.equal(state.state, 'completed', `queued run ${run.runId} must drain to completed`);
  }
});

test('J2: a concurrent double-start runs the workflow exactly once', { skip: e2eSkip }, async () => {
  const created = await h.api.createRun({
    repo: process.cwd(),
    title: 'E2E J2 concurrent double-start',
    description: 'Group J — idempotent start under concurrency.',
    scope: 'No source changes.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'local-change',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  // Fire two starts for the SAME runId in the same tick — DBOS dedups by workflowID=runId. The
  // alreadyStarted flag is racy under a true tie, so the invariant we pin is the durable one: the
  // workflow body executes exactly once regardless of how many concurrent starts land.
  await Promise.all([h.api.startRun({ runId: created.runId }), h.api.startRun({ runId: created.runId })]);
  const state = await waitState(h.api, created.runId);
  assert.equal(state.state, 'completed');
  assert.equal(await countEvents(created.runId, 'run_completed'), 1, 'the workflow must run exactly once');
  assert.equal(await countEvents(created.runId, 'step_succeeded'), 1, 'developer must execute exactly once');
});

test('J3: concurrent runs are isolated — each completes with only its own events', { skip: e2eSkip }, async () => {
  const runs = await Promise.all(Array.from({ length: 4 }, () => startLocalChangeRun(h)));
  for (const run of runs) {
    const state = await waitState(h.api, run.runId);
    assert.equal(state.state, 'completed');
    // Each run's event query (server-filtered by run_id) returns exactly its own lifecycle —
    // one run_created, one developer step, one run_completed — proving no cross-contamination.
    assert.equal(await countEvents(run.runId, 'run_created'), 1, `${run.runId}: one run_created`);
    assert.equal(await countEvents(run.runId, 'step_succeeded'), 1, `${run.runId}: developer ran once`);
    assert.equal(await countEvents(run.runId, 'run_completed'), 1, `${run.runId}: one run_completed`);
  }
});

test('J4: gates of concurrent runs resolve independently', { skip: e2eSkip }, async () => {
  const targets = [createTargetRepo(), createTargetRepo(), createTargetRepo()];
  try {
    const runs = await Promise.all(targets.map((t) => startStubbedFeatureRun(h, t)));
    // All park at their own plan gate, then all drive to terminal concurrently — each run's recv
    // is keyed by its own workflowID, so signals never cross between runs.
    await Promise.all(runs.map((r) => waitForGate(h.api, r.runId, 'plan')));
    const terminals = await Promise.all(runs.map((r) => approveUntilTerminal(h.api, r.runId)));
    for (const t of terminals) assert.equal(t.state, 'completed');
  } finally {
    targets.forEach((t) => t.cleanup());
  }
});

test('J5: concurrent mixed terminals — approve one gate, reject another — each resolves correctly', { skip: e2eSkip }, async () => {
  const targets: TargetRepo[] = [createTargetRepo(), createTargetRepo()];
  try {
    const [keep, kill] = await Promise.all(targets.map((t) => startStubbedFeatureRun(h, t)));
    const [, killGate] = await Promise.all([
      waitForGate(h.api, keep.runId, 'plan'),
      waitForGate(h.api, kill.runId, 'plan'),
    ]);
    // Resolve two parked runs to OPPOSITE terminals in the same tick — approve drives one through
    // to completion, reject signals the other's recv and cancels it (B3). Both resolve via gate
    // signals (no lingering workflow), and the per-run deterministic terminal writes must not cross.
    const [terminal] = await Promise.all([
      approveUntilTerminal(h.api, keep.runId),
      h.api.rejectGate({ inboxId: killGate.inboxId, resolvedBy: 'e2e' }),
    ]);
    assert.equal(terminal.state, 'completed');
    await waitState(h.api, kill.runId); // let the reject settle the run (waitForRun reports a cancelled run as a settled non-gate state)
    const killed = await h.api.getRun({ runId: kill.runId });
    assert.equal(killed.run.status, 'cancelled'); // plan-gate reject cancels the run (B3), even concurrently with another's approval
    assert.equal(await countEvents(keep.runId, 'run_completed'), 1);
    assert.equal(await countEvents(kill.runId, 'run_cancelled'), 1);
  } finally {
    targets.forEach((t) => t.cleanup());
  }
});
