import assert from 'node:assert/strict';
import { test } from 'node:test';
import { e2eSkip } from '../../support/env.js';
import { createRuntimeLifecycleContext } from '../../support/runtime-lifecycle-context.js';

test('runtime host lifecycle starts, stops, restarts, and cleans an isolated profile', { skip: e2eSkip }, async () => {
  const runtime = await createRuntimeLifecycleContext();
  try {
    const first = await runtime.startHost();
    assert.ok(first.pid > 0);
    assert.ok(first.graphqlPort > 0);

    await runtime.stopHost();
    assert.equal(runtime.isStopped(), true);

    const restarted = await runtime.restartHost();
    assert.notEqual(restarted.pid, first.pid);
    assert.ok(restarted.graphqlPort > 0);

    await runtime.stopHost();
    assert.equal(runtime.isStopped(), true);
  } finally {
    await runtime.cleanup();
  }
});
