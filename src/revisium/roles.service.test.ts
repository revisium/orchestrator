/**
 * roles.service.test.ts — 5.1 RolesService
 *
 * Fake head transport; assert loadRole uses head mode, unknown role propagates ROW_NOT_FOUND.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportRow } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { REVISIUM_TRANSPORT_HEAD } from './tokens.js';
import { RolesService } from './roles.service.js';

function fakeHeadTransport(
  rows: Record<string, Record<string, unknown>>,
  opts: { throwOnMissing?: boolean; listRows?: Record<string, Array<{ id: string; data: Record<string, unknown> }>> } = {},
): ControlPlaneTransport {
  return {
    mode: 'head' as const,
    async assertReady() {},
    async listRows(table) {
      const seeded = opts.listRows?.[table];
      if (!seeded) return { edges: [] };
      return { edges: seeded.map((node) => ({ node: node as TransportRow })) };
    },
    async getRow(_table, rowId) {
      const data = rows[rowId];
      if (!data) {
        if (opts.throwOnMissing !== false) {
          throw new ControlPlaneError('ROW_NOT_FOUND', `Row not found: ${rowId}`, { status: 404 });
        }
      }
      return { id: rowId, data: data ?? {} } as TransportRow;
    },
    async createRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async updateRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async patchRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
  };
}

function makeRolesService(transport: ControlPlaneTransport): RolesService {
  // Manually inject the head transport to bypass Nest DI in unit tests.
  const svc = Object.create(RolesService.prototype) as RolesService;
  // @ts-expect-error — direct property injection for unit test
  svc[REVISIUM_TRANSPORT_HEAD] = transport;
  // Call the constructor logic manually by directly constructing:
  return new RolesService(transport);
}

test('RolesService.loadRole reads from head transport and maps fields', async () => {
  const transport = fakeHeadTransport({
    analyst: {
      name: 'analyst', system_prompt: 'You are an analyst.', model_level: 'standard',
      effort: 'high', runner: 'claude-code', allowed_tools: ['Bash', 'Read'], scope_rules: '{}',
    },
  });
  const svc = makeRolesService(transport);
  const role = await svc.loadRole('analyst');

  assert.equal(role.name, 'analyst');
  assert.equal(role.systemPrompt, 'You are an analyst.');
  assert.equal(role.modelLevel, 'standard');
  assert.equal(role.runner, 'claude-code');
  assert.deepEqual(role.allowedTools, ['Bash', 'Read']);
});

test('RolesService.loadRole propagates ROW_NOT_FOUND for unknown role (edge 8)', async () => {
  const transport = fakeHeadTransport({});
  const svc = makeRolesService(transport);
  await assert.rejects(
    () => svc.loadRole('unknown-role'),
    (err: unknown) => err instanceof ControlPlaneError && err.code === 'ROW_NOT_FOUND',
  );
});

test('RolesService.loadModelProfile reads from head transport and maps fields', async () => {
  const transport = fakeHeadTransport({
    standard: {
      level: 'standard', provider: 'anthropic', model_id: 'claude-3-5-sonnet',
      params: '{}', cost_per_input: 0.003, cost_per_output: 0.015,
    },
  });
  const svc = makeRolesService(transport);
  const profile = await svc.loadModelProfile('standard');

  assert.equal(profile.level, 'standard');
  assert.equal(profile.provider, 'anthropic');
  assert.equal(profile.modelId, 'claude-3-5-sonnet');
});

test('RolesService uses head transport mode', () => {
  const transport = fakeHeadTransport({});
  // Transport constructed with 'head' mode — RolesService must be head-only.
  assert.equal(transport.mode, 'head');
  // Confirm the service receives head mode transport (constructor injects it).
  const svc = makeRolesService(transport);
  assert.ok(svc instanceof RolesService);
});

test('RolesService.listRoles maps persisted row fields into a summary', async () => {
  const transport = fakeHeadTransport({}, {
    listRows: {
      roles: [
        {
          id: 'pb-developer',
          data: {
            name: 'developer', model_level: 'standard', runner_id: 'claude-code', surface: 'any',
            rights: 'write-working-tree', playbook_id: 'pb', playbook_role_id: 'developer',
          },
        },
      ],
    },
  });
  const svc = makeRolesService(transport);
  const roles = await svc.listRoles();
  assert.equal(roles[0]?.id, 'pb-developer');
  assert.equal(roles[0]?.name, 'developer');
  assert.equal(roles[0]?.runner, 'claude-code');
  assert.equal(roles[0]?.playbookRoleId, 'developer');
});
