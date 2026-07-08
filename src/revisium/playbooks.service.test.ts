import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportList, TransportRow } from '../control-plane/transport.js';
import type { ListRowsOptions } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { PlaybookInstaller, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { PlaybooksService } from './playbooks.service.js';

function makeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data };
}

function valueAtPath(data: Record<string, unknown> | undefined, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, data ?? {});
}

function matchesWhere(row: TransportRow, where: ListRowsOptions['where']): boolean {
  if (!where) return true;
  if (where.id?.equals !== undefined && row.id !== where.id.equals) return false;
  if (where.id?.in !== undefined && !where.id.in.includes(row.id)) return false;
  if (where.data?.path !== undefined && where.data.equals !== undefined && valueAtPath(row.data, where.data.path) !== where.data.equals) return false;
  if (where.data?.path !== undefined && where.data.in !== undefined && !where.data.in.includes(valueAtPath(row.data, where.data.path))) return false;
  if (where.AND?.some((item) => !matchesWhere(row, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(row, item))) return false;
  const not = where.NOT;
  if (Array.isArray(not) && not.some((item) => matchesWhere(row, item))) return false;
  if (not && !Array.isArray(not) && matchesWhere(row, not)) return false;
  return true;
}

function fakeHeadTransport(
  rows: TransportRow[],
  playbookRows: TransportRow[] = [],
  runProfileRows: TransportRow[] = [],
): ControlPlaneTransport & { listCalls: Array<{ table: string; options?: ListRowsOptions }> } {
  const listCalls: Array<{ table: string; options?: ListRowsOptions }> = [];
  function sourceFor(table: string): TransportRow[] {
    if (table === 'playbooks') return playbookRows;
    if (table === 'run_profiles') return runProfileRows;
    if (table === 'pipelines') return rows;
    return [];
  }
  return {
    listCalls,
    mode: 'head',
    async assertReady() {},
    async listRows(table, options): Promise<TransportList> {
      listCalls.push({ table, options });
      let selected = sourceFor(table).filter((node) => matchesWhere(node, options?.where));
      const afterIndex = options?.after ? selected.findIndex((node) => node.id === options.after) : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      selected = selected.slice(start, start + (options?.first ?? selected.length));
      return { edges: selected.map((node) => ({ cursor: node.id, node })) };
    },
    async getRow(table, rowId) {
      const source = sourceFor(table);
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
      status: 'active',
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

test('PlaybooksService hides removed pipeline rows and resolves only canonical pipeline ids', async () => {
  const head = fakeHeadTransport([
    makeRow('pb-feature-development', {
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      path: 'pipelines/feature-development/PIPELINE.md',
      status: 'active',
    }),
    makeRow('pb-removed-pipeline', {
      playbook_id: 'pb',
      pipeline_id: 'removed-pipeline',
      path: 'pipelines/feature-development/PIPELINE.md',
      status: 'removed',
    }),
  ], [
    makeRow('pb', {
      name: 'PB',
      package_name: '@x/pb',
      version: '1.0.0',
      source: 'local:/pb',
      schema_version: 2,
    }),
  ]);
  const svc = new PlaybooksService(head);

  const pipelines = await svc.listPipelines();

  assert.deepEqual(pipelines.map((pipeline) => pipeline.pipelineId), ['feature-development']);
  assert.deepEqual(head.listCalls[0], {
    table: 'pipelines',
    options: {
      first: 500,
      after: undefined,
      where: { data: { path: 'status', equals: 'active' } },
    },
  });
  await assert.rejects(
    () => svc.resolvePipeline({ playbookId: 'pb', pipelineId: 'pb-feature-development' }),
    (err: ControlPlaneError) => err.code === 'ROW_NOT_FOUND',
  );
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

test('PlaybooksService.listPlaybooks exposes catalogHash for seed freshness checks', async () => {
  const svc = new PlaybooksService(fakeHeadTransport([], [
    makeRow('revisium-default', {
      name: 'Revisium Default Playbook',
      package_name: '@revisium/orchestrator-default-playbook',
      version: '0.1.1',
      source: 'local:@revisium/orchestrator-default-playbook@0.1.1',
      schema_version: 2,
      catalog_hash: 'abc123',
    }),
  ]));

  const playbooks = await svc.listPlaybooks();

  assert.equal(playbooks[0]?.catalogHash, 'abc123');
});

test('PlaybooksService.listRunProfiles filters profiles by playbook and pipeline', async () => {
  const head = fakeHeadTransport([], [
    makeRow('pb', {
      name: 'PB',
      package_name: '@x/pb',
      version: '1.0.0',
      source: 'local:/pb',
      schema_version: 2,
    }),
  ], [
    makeRow('pb-codex-standard', {
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      profile_id: 'codex-standard',
      schema_version: 'run-profile/v1',
      version: '1',
      display_name: 'Codex standard',
      summary: 'Codex launch profile.',
      profile_json: JSON.stringify({ id: 'codex-standard', pipelineId: 'feature-development' }),
      profile_hash: 'hash-1',
      status: 'active',
    }),
    makeRow('pb-local', {
      playbook_id: 'pb',
      pipeline_id: 'local-change',
      profile_id: 'local',
      schema_version: 'run-profile/v1',
      version: '1',
      display_name: 'Local',
      summary: 'Local profile.',
      profile_json: JSON.stringify({ id: 'local', pipelineId: 'local-change' }),
      profile_hash: 'hash-2',
      status: 'active',
    }),
    makeRow('pb-removed-profile', {
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      profile_id: 'removed-profile',
      schema_version: 'run-profile/v1',
      version: '1',
      display_name: 'Removed',
      summary: 'Removed profile.',
      profile_json: JSON.stringify({ id: 'removed-profile', pipelineId: 'feature-development' }),
      profile_hash: 'hash-3',
      status: 'removed',
    }),
  ]);
  const svc = new PlaybooksService(head);

  const profiles = await svc.listRunProfiles({ playbookId: 'pb', pipelineId: 'feature-development' });

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0]?.profileId, 'codex-standard');
  assert.deepEqual(profiles[0]?.profile, { id: 'codex-standard', pipelineId: 'feature-development' });
  assert.deepEqual(head.listCalls, [{
    table: 'run_profiles',
    options: {
      first: 500,
      after: undefined,
      where: {
        AND: [
          { data: { path: 'playbook_id', equals: 'pb' } },
          { data: { path: 'pipeline_id', equals: 'feature-development' } },
          { data: { path: 'status', equals: 'active' } },
        ],
      },
    },
  }]);
});

test('PlaybooksService.resolveRunProfile rejects scoped row ids as profileId', async () => {
  const svc = new PlaybooksService(fakeHeadTransport([], [
    makeRow('pb', {
      name: 'PB',
      package_name: '@x/pb',
      version: '1.0.0',
      source: 'local:/pb',
      schema_version: 2,
    }),
  ], [
    makeRow('pb-codex-standard', {
      playbook_id: 'pb',
      pipeline_id: 'feature-development',
      profile_id: 'codex-standard',
      schema_version: 'run-profile/v1',
      version: '1',
      display_name: 'Codex standard',
      summary: 'Codex launch profile.',
      profile_json: JSON.stringify({ id: 'codex-standard', pipelineId: 'feature-development' }),
      profile_hash: 'hash-1',
      status: 'active',
    }),
  ]));

  await assert.rejects(
    () => svc.resolveRunProfile({
      playbookId: 'pb',
      pipelineId: 'feature-development',
      profileId: 'pb-codex-standard',
    }),
    (err: ControlPlaneError) => err.code === 'ROW_NOT_FOUND',
  );
});

test('PlaybooksService.resolveRunProfile rejects profiles outside the selected pipeline', async () => {
  const svc = new PlaybooksService(fakeHeadTransport([], [
    makeRow('pb', {
      name: 'PB',
      package_name: '@x/pb',
      version: '1.0.0',
      source: 'local:/pb',
      schema_version: 2,
    }),
  ], [
    makeRow('pb-local', {
      playbook_id: 'pb',
      pipeline_id: 'local-change',
      profile_id: 'local',
      schema_version: 'run-profile/v1',
      version: '1',
      display_name: 'Local',
      summary: 'Local profile.',
      profile_json: JSON.stringify({ id: 'local', pipelineId: 'local-change' }),
      profile_hash: 'hash-2',
      status: 'active',
    }),
  ]));

  await assert.rejects(
    () => svc.resolveRunProfile({ playbookId: 'pb', pipelineId: 'feature-development', profileId: 'local' }),
    (err: ControlPlaneError) => err.code === 'ROW_NOT_FOUND',
  );
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
    roles: 0, pipelines: 0, runProfiles: 0, operations: [], committed: false, dryRun: false,
    ...result,
  } satisfies PlaybookInstallResult));
}

test('PlaybooksService.install invalidates the cached HEAD scope after a commit', async (t) => {
  t.after(() => mock.restoreAll());
  stubInstaller({ committed: true });
  const head = fakeInvalidatableHead();

  const result = await new PlaybooksService(head, {} as never, {} as never).install({ source: '/tmp/pb', commit: true });

  assert.equal(result.committed, true);
  assert.equal(head.invalidations, 1, 'committed install must drop the boot revision so reads see new rows');
});

test('PlaybooksService.install does not invalidate when nothing was committed', async (t) => {
  t.after(() => mock.restoreAll());
  stubInstaller({ committed: false, dryRun: true });
  const head = fakeInvalidatableHead();

  await new PlaybooksService(head, {} as never, {} as never).install({ source: '/tmp/pb', dryRun: true });

  assert.equal(head.invalidations, 0, 'dry-run/non-commit must not churn the cached scope');
});
