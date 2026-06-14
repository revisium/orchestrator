import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportList, TransportRow } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { PlaybooksService } from './playbooks.service.js';

function makeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data };
}

function fakeHeadTransport(rows: TransportRow[]): ControlPlaneTransport {
  return {
    mode: 'head',
    async assertReady() {},
    async listRows(table): Promise<TransportList> {
      if (table !== 'pipelines') return { edges: [] };
      return { edges: rows.map((node) => ({ node })) };
    },
    async getRow(_table, rowId) {
      const row = rows.find((item) => item.id === rowId);
      if (!row) throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
      return row;
    },
    async createRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async updateRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async patchRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
  };
}

test('PlaybooksService.listPipelines tolerates malformed JSON fields', async () => {
  const svc = new PlaybooksService(fakeHeadTransport([
    makeRow('pb-feature-development', {
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      path: 'pipelines/feature-development/PIPELINE.md',
      triggers: ['new feature'],
      required_roles: ['developer'],
      alternative_roles_json: '{not json',
      optional_roles: [],
      route_gates: ['plan'],
      execution_policy_json: '{not json',
    }),
  ]));

  const pipelines = await svc.listPipelines();

  assert.equal(pipelines.length, 1);
  assert.equal(pipelines[0]?.pipelineId, 'feature-development');
  assert.deepEqual(pipelines[0]?.alternativeRoles, []);
  assert.deepEqual(pipelines[0]?.executionPolicy, {});
});
