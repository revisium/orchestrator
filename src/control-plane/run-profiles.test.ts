import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRunProfile } from './run-profile-contract.js';

test('run-profile materialization evidence uses exact pinned agent bindings', () => {
  const profile = {
    schemaVersion: 'run-profile/v1',
    topology: { stages: { developer: { mode: 'single' } } },
    bindings: {
      slots: {
        'node:developer': {
          runnerId: 'codex',
          provider: 'openai',
          modelId: 'gpt-exact',
          modelParams: { maxTurns: 12 },
          permissionMode: 'workspace-write',
        },
      },
    },
  } as const;

  assert.deepEqual(validateRunProfile(profile), profile);
  assert.throws(
    () => validateRunProfile({
      ...profile,
      bindings: {
        slots: {
          'node:developer': {
            ...profile.bindings.slots['node:developer'],
            modelLevel: 'deep',
          },
        },
      },
    }),
    (error: unknown) => (error as { code?: string }).code === 'profile_schema_invalid',
  );
});
