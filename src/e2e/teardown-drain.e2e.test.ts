import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  givenFeatureRunAtPlanGate,
  createTargetRepo,
} from './kit/index.js';

// Performance contract (see AGENTS.md): tearing down a host with a workflow parked at a human gate
// must NOT block on the DBOS shutdown drain. That drain can never complete for a parked workflow, so
// without a low REVO_SHUTDOWN_DRAIN_TIMEOUT_MS every e2e file would pay the full 8 s — turning a
// wait-bounded suite into a drain-bounded one. This pins that e2e teardown stays fast.
let h: RunHarness;

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness();
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close(); // idempotent; the test already closes — this only guards an early throw
});

test('teardown with a workflow parked at a gate returns fast — no drain stall', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  await givenFeatureRunAtPlanGate(h, target); // a real workflow is now parked at DBOS.recv

  const started = Date.now();
  await h.close();
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < 500,
    `host teardown must not block on the DBOS drain (took ${elapsed}ms); ` +
      'set REVO_SHUTDOWN_DRAIN_TIMEOUT_MS low for the e2e home (see test:e2e + AGENTS.md).',
  );
});
