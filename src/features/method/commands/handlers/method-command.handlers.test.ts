import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { CreateRunProfileCommand } from '../impl/create-run-profile.command.js';
import { DeprecateRunProfileCommand } from '../impl/deprecate-run-profile.command.js';
import { UpdateRunProfileCommand } from '../impl/update-run-profile.command.js';
import {
  CreateRunProfileHandler,
  DeprecateRunProfileHandler,
  UpdateRunProfileHandler,
} from './method-command.handlers.js';

test('method command handlers delegate run profile mutations through TaskControlPlaneApiService', async () => {
  const calls: string[] = [];
  const profile = { schemaVersion: 'run-profile/v1', topology: { stages: {} }, bindings: { slots: {} } };
  const api = {
    async createProfile(input: unknown) {
      calls.push(`create:${JSON.stringify(input)}`);
      return { profileId: 'custom-exact' };
    },
    async updateProfile(input: unknown) {
      calls.push(`update:${JSON.stringify(input)}`);
      return { profileId: 'custom-exact' };
    },
    async deprecateProfile(input: unknown) {
      calls.push(`deprecate:${JSON.stringify(input)}`);
      return { profileId: 'custom-exact', status: 'deprecated' };
    },
  } as unknown as TaskControlPlaneApiService;

  assert.equal((await new CreateRunProfileHandler(api).execute(new CreateRunProfileCommand({
    pipelineId: 'local-change',
    profileId: 'custom-exact',
    displayName: 'Custom exact',
    profile,
  }))).profileId, 'custom-exact');
  assert.equal((await new UpdateRunProfileHandler(api).execute(new UpdateRunProfileCommand({
    pipelineId: 'local-change',
    profileId: 'custom-exact',
    expectedProfileRevisionHash: 'hash',
    profile,
  }))).profileId, 'custom-exact');
  assert.equal((await new DeprecateRunProfileHandler(api).execute(new DeprecateRunProfileCommand({
    pipelineId: 'local-change',
    profileId: 'custom-exact',
    expectedProfileRevisionHash: 'hash',
  }))).status, 'deprecated');

  assert.deepEqual(calls, [
    `create:${JSON.stringify({ pipelineId: 'local-change', profileId: 'custom-exact', displayName: 'Custom exact', profile })}`,
    `update:${JSON.stringify({ pipelineId: 'local-change', profileId: 'custom-exact', expectedProfileRevisionHash: 'hash', profile })}`,
    'deprecate:{"pipelineId":"local-change","profileId":"custom-exact","expectedProfileRevisionHash":"hash"}',
  ]);
});
