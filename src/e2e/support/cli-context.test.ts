import assert from 'node:assert/strict';
import test from 'node:test';
import { CliContext } from './cli-context.js';
import type { IsolatedProfile } from './isolated-profile.js';

test('CLI context derives host state from one runtime observation', () => {
  let runtimeReads = 0;
  const profile = {
    runtime() {
      runtimeReads += 1;
      return { pid: process.pid };
    },
    running() {
      assert.fail('hostState must not perform a second runtime observation');
    },
  } as unknown as IsolatedProfile;

  assert.deepEqual(new CliContext(profile).hostState(), { running: true, pid: process.pid });
  assert.equal(runtimeReads, 1);
});
