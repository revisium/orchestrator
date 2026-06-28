import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportList, TransportRow } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { PlaybookInstaller, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { PlaybooksService } from './playbooks.service.js';

function makeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data };
}

function fakeHeadTransport(rows: TransportRow[], playbookRows: TransportRow[] = []): ControlPlaneTransport {
  return {
    mode: 'head',
    async assertReady() {},
    async listRows(table): Promise<TransportList> {
      if (table === 'playbooks') return { edges: playbookRows.map((node) => ({ node })) };
      if (table !== 'pipelines') return { edges: [] };
      return { edges: rows.map((node) => ({ node })) };
    },
    async getRow(table, rowId) {
      const source = table === 'playbooks' ? playbookRows : rows;
      const row = source.find((item) => item.id === rowId);
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

test('PlaybooksService.resolvePlaybook prefers revisium-default when multiple playbooks are installed', async () => {
  const svc = new PlaybooksService(fakeHeadTransport([], [
    makeRow('revisium-agent-playbook', {
      name: 'Revisium Agent Playbook (e2e fixture)',
      package_name: '@revisium/agent-playbook-e2e-fixture',
      version: '0.0.0',
      source: 'local:@revisium/agent-playbook-e2e-fixture@0.0.0',
      schema_version: 2,
    }),
    makeRow('revisium-default', {
      name: 'Revisium Default Playbook',
      package_name: '@revisium/orchestrator-default-playbook',
      version: '0.1.1',
      source: 'local:@revisium/orchestrator-default-playbook@0.1.1',
      schema_version: 2,
    }),
  ]));

  const playbook = await svc.resolvePlaybook();

  assert.equal(playbook.id, 'revisium-default');
});

// --- slice 144 B2: a committed install must invalidate the cached HEAD read-scope -----------------

/** Head transport that records invalidate() calls; the read methods are unused by these tests. */
function fakeInvalidatableHead(): ControlPlaneTransport & { invalidate(): void; invalidations: number } {
  let invalidations = 0;
  return {
    mode: 'head',
    async assertReady() {},
    async listRows(): Promise<TransportList> { return { edges: [] }; },
    async getRow() { throw new ControlPlaneError('ROW_NOT_FOUND', 'unused', { status: 404 }); },
    async createRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async updateRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    async patchRow() { throw new ControlPlaneError('VALIDATION_FAILURE', 'head is read-only'); },
    invalidate() { invalidations += 1; },
    get invalidations() { return invalidations; },
  } as ControlPlaneTransport & { invalidate(): void; invalidations: number };
}

/** Stub the real installer (needs a live daemon + source dir) so the test isolates the invalidate seam. */
function stubInstaller(result: Partial<PlaybookInstallResult>): void {
  mock.method(PlaybookInstaller.prototype, 'install', async () => ({
    playbookId: 'pb', name: 'pb', version: '1.0.0', source: 'local',
    roles: 0, pipelines: 0, operations: [], committed: false, dryRun: false,
    ...result,
  } satisfies PlaybookInstallResult));
}

test('PlaybooksService.install invalidates the cached HEAD scope after a commit', async (t) => {
  t.after(() => mock.restoreAll());
  stubInstaller({ committed: true });
  const head = fakeInvalidatableHead();

  const result = await new PlaybooksService(head).install({ source: '/tmp/pb', commit: true });

  assert.equal(result.committed, true);
  assert.equal(head.invalidations, 1, 'committed install must drop the boot revision so reads see new rows');
});

test('PlaybooksService.install does not invalidate when nothing was committed', async (t) => {
  t.after(() => mock.restoreAll());
  stubInstaller({ committed: false, dryRun: true });
  const head = fakeInvalidatableHead();

  await new PlaybooksService(head).install({ source: '/tmp/pb', dryRun: true });

  assert.equal(head.invalidations, 0, 'dry-run/non-commit must not churn the cached scope');
});
