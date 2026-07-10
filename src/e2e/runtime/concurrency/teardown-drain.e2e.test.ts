import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';
import { createTeardownContext, type TeardownContext } from '../../support/teardown-context.js';

let runtime: TeardownContext;

before(async () => {
  if (!RUN_REAL_E2E) return;
  runtime = await createTeardownContext();
});

after(async () => {
  if (runtime) await runtime.cleanup();
});

test('teardown with a workflow parked at a gate remains wait-bounded', { skip: e2eSkip }, async () => {
  await runtime.parkAtHumanGate();
  const elapsed = await runtime.closeParkedHost();
  assert.ok(
    elapsed < 500,
    `host teardown must not block on the DBOS drain (took ${elapsed}ms); ` +
      'REVO_SHUTDOWN_DRAIN_TIMEOUT_MS must remain low for the E2E home.',
  );
});
