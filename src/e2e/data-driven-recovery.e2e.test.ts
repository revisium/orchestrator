import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  crashDataDrivenRunAt,
  scriptedAgent,
  waitForGate,
  approveUntilTerminal,
  assertEventsPresent,
  assertReplayIdempotent,
} from './kit/index.js';

// Group L (recovery) — DURABILITY / CRASH-RECOVERY of the DATA-DRIVEN adapter (plan 0015 slice 2).
//
// Mirrors recovery.e2e.test.ts EXACTLY: DBOS holds "progress" in Postgres; a crashed host leaves the
// in-flight DATA-DRIVEN workflow PENDING, recovered + replayed on the next launch. core.step is
// deterministic and every effect is a memoized DBOS step, so replay re-derives the identical Decision
// sequence and consumes the recorded step results — no live race, no duplicate effects.
//
// Ordering is load-bearing (the recovery.e2e.test.ts contract): the run is crashed in `before()` —
// each in its own throwaway process — BEFORE any long-lived harness exists, then ONE host is launched
// whose single DBOS.launch() recovers it. This avoids a competing host on the shared DBOS queue
// stealing the recovered workflow and running it with the wrong agent. The recovery host uses a
// constant clean-watcher agent so any replayed (non-recorded) effect still routes deterministically.

let h: RunHarness;
const crashed: { mergeResume: string } = { mergeResume: '' };

before(async () => {
  if (!RUN_REAL_E2E) return;
  // Crash a data-driven run at the merge gate (plan+developer+integrate+watcher durably recorded), THEN
  // launch one host that recovers it. The host's agent is irrelevant for already-recorded steps but is
  // set to the clean-watcher constant for determinism on any replayed effect.
  crashed.mergeResume = (await crashDataDrivenRunAt('merge-gate')).runId;
  h = await createRunHarness({
    agent: (sink) => scriptedAgent({ byRole: { watcher: { kind: 'domainVerdict', verdict: 'clean' } } }, sink),
  });
});

after(async () => {
  if (h) await h.close();
});

test('L2: a data-driven run crashed at the merge gate recovers + completes with no duplicate events', { skip: e2eSkip }, async () => {
  await waitForGate(h.api, crashed.mergeResume, 'merge'); // recovered, re-parked at the merge gate
  const terminal = await approveUntilTerminal(h.api, crashed.mergeResume);
  assert.equal(terminal.state, 'completed');
  await assertEventsPresent(h.api, crashed.mergeResume, ['run_completed']);
  // Replay after recovery must be exactly-once: no duplicate run_completed / step_succeeded.
  await assertReplayIdempotent(h.api, crashed.mergeResume);
});
