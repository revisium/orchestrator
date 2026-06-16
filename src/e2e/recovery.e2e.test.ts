import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  crashRunAt,
  waitForGate,
  waitState,
  approveUntilTerminal,
  assertEventsPresent,
  assertReplayIdempotent,
} from './kit/index.js';

// Group F — DURABILITY / CRASH-RECOVERY. DBOS holds "progress" in Postgres; when a host crashes the
// in-flight workflow is left PENDING and is recovered + replayed on the next host launch.
//
// DBOS is a process-global singleton, so a process can host only ONE engine (a second one clashes on
// workflow re-registration). We therefore crash several runs FIRST — each in its own throwaway
// process (`crashRunAt` → the child exits without draining DBOS, a real crash) — and then boot ONE
// host whose single DBOS.launch() recovers them all at once (this also exercises multi-run queue
// recovery). Each test then drives its recovered run and asserts it resumes to the correct terminal
// state with no duplicated side effects — the refactor safety-net for the engine's durability.

let h: RunHarness;
const crashed: { planResume: string; mergeResume: string; planReject: string } = {
  planResume: '',
  mergeResume: '',
  planReject: '',
};

before(async () => {
  if (!RUN_REAL_E2E) return;
  // Crash three runs at their durable points, THEN launch one host that recovers all of them.
  crashed.planResume = (await crashRunAt('plan-gate')).runId;
  crashed.mergeResume = (await crashRunAt('merge-gate')).runId;
  crashed.planReject = (await crashRunAt('plan-gate')).runId;
  h = await createRunHarness(); // single DBOS.launch() recovers every PENDING workflow above
});

after(async () => {
  if (h) await h.close();
});

test('F1: a run crashed at the plan gate is recovered and resumes to completion', { skip: e2eSkip }, async () => {
  await waitForGate(h.api, crashed.planResume, 'plan'); // recovered, re-parked at the plan gate
  const terminal = await approveUntilTerminal(h.api, crashed.planResume);
  assert.equal(terminal.state, 'completed');
  await assertEventsPresent(h.api, crashed.planResume, ['run_completed']);
});

test('F2: a run crashed at the merge gate recovers + completes with no duplicate events', { skip: e2eSkip }, async () => {
  await waitForGate(h.api, crashed.mergeResume, 'merge'); // recovered past plan+developer+integrate, parked at merge
  const terminal = await approveUntilTerminal(h.api, crashed.mergeResume);
  assert.equal(terminal.state, 'completed');
  await assertReplayIdempotent(h.api, crashed.mergeResume); // run_completed once; no duplicate step_succeeded
});

test('F3: a recovered run can still be rejected at the plan gate (blocks the run)', { skip: e2eSkip }, async () => {
  const gate = await waitForGate(h.api, crashed.planReject, 'plan'); // recovered, parked
  await h.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: 'e2e' }); // signal recv with reject
  await waitState(h.api, crashed.planReject); // workflow returns after routing to the blocked terminal
  const detail = await h.api.getRun({ runId: crashed.planReject });
  // SPEC-CORRECT DIFFERENCE (plan 0015 slice 3): a plan-gate reject now routes to the data-driven
  // `blocked` terminal (see B3) rather than the old hard-cancel — still a non-completed terminal, and
  // the recv signal + gate routing survive crash-recovery exactly as before.
  assert.notEqual(detail.run.status, 'completed', 'a rejected plan gate must not complete, even post-recovery');
});
