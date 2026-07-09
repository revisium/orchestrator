import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { GetRunProfileQuery } from '../impl/get-run-profile.query.js';
import { GetPipelineQuery } from '../impl/get-pipeline.query.js';
import { GetRoleQuery } from '../impl/get-role.query.js';
import { ListRunProfilesQuery } from '../impl/list-run-profiles.query.js';
import { ListPipelinesQuery } from '../impl/list-pipelines.query.js';
import { ListPlaybooksQuery } from '../impl/list-playbooks.query.js';
import { ListRolesQuery } from '../impl/list-roles.query.js';
import { ValidateRunProfileQuery } from '../impl/validate-run-profile.query.js';
import {
  GetRunProfileHandler,
  GetPipelineHandler,
  GetRoleHandler,
  ListRunProfilesHandler,
  ListPipelinesHandler,
  ListPlaybooksHandler,
  ListRolesHandler,
  ValidateRunProfileHandler,
} from './method-query.handlers.js';

test('method query handlers delegate and normalize method records', async () => {
  const pipeline = {
    id: 'pipe_1',
    playbookId: 'playbook_1',
    pipelineId: 'default',
    path: 'pipeline.yml',
    triggers: ['build'],
    requiredRoles: ['developer'],
    alternativeRoles: [{ group_id: 'review', roles: ['reviewer'], resolution: 'first_available' }],
    optionalRoles: [],
    routeGates: ['plan'],
    executionPolicy: {},
  };
  const api = {
    async listRoles() {
      return [{ id: 'role_1', name: 'developer', modelLevel: 'standard', runner: 'codex', surface: '', rights: '', playbookId: 'playbook_1', playbookRoleId: 'developer' }];
    },
    async getRole(id: string) {
      assert.equal(id, 'developer');
      return { name: 'developer', systemPrompt: 'Build', modelLevel: 'standard', effort: '', runner: 'codex', allowedTools: [], scopeRules: {} };
    },
    async listPlaybooks() {
      return [{ id: 'playbook_1', name: 'Default', packageName: '@revo/default', version: '1.0.0', source: 'local', schemaVersion: 1 }];
    },
    async listPipelines() {
      return [pipeline];
    },
    async getPipeline(id: string) {
      assert.equal(id, 'pipe_1');
      return pipeline;
    },
    async listProfilesPage(input: unknown) {
      assert.deepEqual(input, { pipelineId: 'local-change', first: 51 });
      return {
        profiles: [{ id: 'row_1', playbookId: 'pb', pipelineId: 'local-change', profileId: 'custom', schemaVersion: 'run-profile/v1', version: '1', displayName: 'Custom', summary: '', profile: {}, profileHash: 'hash', profileRevisionHash: 'revision-hash', status: 'active' }],
        totalCount: 1,
      };
    },
    async getProfile(input: unknown) {
      assert.deepEqual(input, { pipelineId: 'local-change', profileId: 'custom' });
      return { id: 'row_1', playbookId: 'pb', pipelineId: 'local-change', profileId: 'custom', schemaVersion: 'run-profile/v1', version: '1', displayName: 'Custom', summary: '', profile: {}, profileHash: 'hash', status: 'active' };
    },
    async validateProfile(input: unknown) {
      assert.deepEqual(input, { pipelineId: 'local-change', profile: {} });
      return { ok: true };
    },
  } as unknown as TaskControlPlaneApiService;

  assert.equal((await new ListRolesHandler(api).execute(new ListRolesQuery({}))).edges[0]?.node.id, 'role_1');
  assert.equal((await new GetRoleHandler(api).execute(new GetRoleQuery({ roleId: 'developer' }))).id, 'developer');
  assert.equal((await new ListPlaybooksHandler(api).execute(new ListPlaybooksQuery({}))).edges[0]?.node.id, 'playbook_1');
  assert.equal((await new ListPipelinesHandler(api).execute(new ListPipelinesQuery({}))).edges[0]?.node.alternativeRoles[0]?.groupId, 'review');
  assert.equal((await new GetPipelineHandler(api).execute(new GetPipelineQuery({ pipelineId: 'pipe_1' }))).alternativeRoles[0]?.groupId, 'review');
  assert.equal((await new ListRunProfilesHandler(api).execute(new ListRunProfilesQuery({ pipelineId: 'local-change' }))).edges[0]?.node.profileId, 'custom');
  assert.equal((await new GetRunProfileHandler(api).execute(new GetRunProfileQuery({ pipelineId: 'local-change', profileId: 'custom' }))).profileId, 'custom');
  assert.deepEqual(await new ValidateRunProfileHandler(api).execute(new ValidateRunProfileQuery({ pipelineId: 'local-change', profile: {} })), { ok: true });
});

test('ListRunProfilesHandler keeps storage totalCount while fetching a bounded page', async () => {
  const api = {
    async listProfilesPage(input: unknown) {
      assert.deepEqual(input, { pipelineId: 'feature-development', first: 2 });
      return {
        profiles: [
          { profileId: 'a', pipelineId: 'feature-development' },
          { profileId: 'b', pipelineId: 'feature-development' },
        ],
        totalCount: 4,
      };
    },
  } as unknown as TaskControlPlaneApiService;

  const connection = await new ListRunProfilesHandler(api).execute(new ListRunProfilesQuery({
    pipelineId: 'feature-development',
    first: 1,
  }));

  assert.deepEqual(connection.edges.map((edge) => edge.node.profileId), ['a']);
  assert.equal(connection.totalCount, 4);
  assert.equal(connection.pageInfo.hasNextPage, true);
});
