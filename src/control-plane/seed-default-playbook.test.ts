/**
 * seed-default-playbook.test.ts — slice 5 (plan 0015)
 *
 * Proves the BUILT-IN DEFAULT playbook (control-plane/default-playbook/) is shippable WITHOUT a live
 * daemon and that the seed install is idempotent. Distinct from the e2e fixture playbook — this is the
 * artifact `revo bootstrap` installs out-of-the-box.
 *
 * Assertions:
 *   1. The default playbook installs via the REAL PlaybookInstaller (fake access) as `revisium-default`
 *      with the expected roles + pipelines (feature-development + local-change).
 *   2. Every pipeline carries a data-driven `template_json` that passes `pipeline-core.validateTemplate`
 *      (zero errors) — the authoritative validator.
 *   3. Every `roleRef`/`scriptRef` a template references is covered by the pipeline's required_roles
 *      AND declared in the roles catalog (the route-binding contract the data-driven adapter relies on).
 *   4. seedDefaultPlaybook is idempotent (skips when already installed) and tolerates a duplicate race.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PlaybookInstaller } from '../playbook/playbook-installer.js';
import type {
  VersionedMeaningAccess,
  VersionedMeaningOperation,
  VersionedMeaningRow,
} from './versioned-meaning.js';
import { validateTemplate } from '../pipeline-core/index.js';
import {
  seedDefaultPlaybook,
  createDaemonInstaller,
  DEFAULT_PLAYBOOK_ID,
  DEFAULT_PLAYBOOK_SOURCE,
  type DefaultPlaybookInstaller,
} from './seed-default-playbook.js';
import type { PlaybookInstallResult } from '../playbook/playbook-installer.js';

// ---------------------------------------------------------------------------
// In-memory versioned-meaning access — records upserts/commits, never touches a daemon.
// ---------------------------------------------------------------------------
function fakeAccess() {
  const rows: VersionedMeaningRow[] = [];
  let committed = false;
  const access: VersionedMeaningAccess = {
    async upsertRow(row) {
      rows.push(row);
      const op: VersionedMeaningOperation = { action: 'create', table: row.table, rowId: row.rowId };
      return op;
    },
    async commit() {
      committed = true;
      return { id: 'rev-default' };
    },
  };
  return { access, rows, get committed() { return committed; } };
}

// ---------------------------------------------------------------------------
// 1. The default playbook installs cleanly with the expected shape.
// ---------------------------------------------------------------------------
test('default playbook: installs as revisium-default with feature-development + local-change', async () => {
  const fake = fakeAccess();
  const installer = new PlaybookInstaller({ access: fake.access });
  const result = await installer.install({
    source: DEFAULT_PLAYBOOK_SOURCE,
    name: DEFAULT_PLAYBOOK_ID,
    commit: true,
  });

  assert.equal(result.playbookId, DEFAULT_PLAYBOOK_ID);
  assert.equal(result.committed, true);
  assert.ok(result.roles >= 5, `expected the core roles to install (got ${result.roles})`);
  assert.equal(result.pipelines, 2, 'feature-development + local-change');

  const pipelineRowIds = fake.rows.filter((r) => r.table === 'pipelines').map((r) => r.rowId);
  assert.ok(
    pipelineRowIds.includes('revisium-default-feature-development'),
    'feature-development pipeline row is written (scoped by playbook id)',
  );
  assert.ok(
    pipelineRowIds.includes('revisium-default-local-change'),
    'local-change pipeline row is written (scoped by playbook id)',
  );
});

// ---------------------------------------------------------------------------
// 2 + 3. Every pipeline template validates AND its capability handles resolve to required_roles.
// ---------------------------------------------------------------------------
type PipelineCatalogEntry = {
  id: string;
  required_roles: string[];
  execution_policy: { template_json?: unknown };
};

const catalogDir = join(DEFAULT_PLAYBOOK_SOURCE, 'catalog');
const pipelines = JSON.parse(
  readFileSync(join(catalogDir, 'pipelines.json'), 'utf8'),
) as PipelineCatalogEntry[];
const roleCatalog = JSON.parse(readFileSync(join(catalogDir, 'roles.json'), 'utf8')) as Array<{ id: string }>;
const declaredRoleIds = new Set(roleCatalog.map((r) => r.id));

/** Walk a template's nodes and collect every `<kind>:<id>` capability handle referenced. */
function capabilityRoleIds(template: { nodes: Record<string, Record<string, unknown>> }): string[] {
  const ids = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    for (const key of ['roleRef', 'scriptRef'] as const) {
      const ref = node[key];
      // A handle is `role:<id>` / `script:<id>`; the engine resolves the suffix against role bindings.
      // The canonical `script:integrator` resolves to whichever binding runs the merge — accept it as
      // satisfied by an `integrator` required role (the default binds one).
      if (typeof ref === 'string' && ref.includes(':')) ids.add(ref.slice(ref.indexOf(':') + 1));
    }
  }
  return [...ids];
}

for (const pipeline of pipelines) {
  test(`default playbook: ${pipeline.id} template validates via validateTemplate (zero errors)`, () => {
    const template = pipeline.execution_policy.template_json as
      | { specVersion: string; nodes: Record<string, Record<string, unknown>> }
      | undefined;
    assert.ok(template, `${pipeline.id} carries execution_policy.template_json`);
    const errors = validateTemplate(template as never).filter((d) => d.severity === 'error');
    assert.deepEqual(errors, [], `${pipeline.id} template must have no validation errors`);
  });

  test(`default playbook: ${pipeline.id} capability handles are covered by required_roles + roles catalog`, () => {
    const template = pipeline.execution_policy.template_json as {
      nodes: Record<string, Record<string, unknown>>;
    };
    const required = new Set(pipeline.required_roles);
    for (const roleId of capabilityRoleIds(template)) {
      assert.ok(
        required.has(roleId),
        `${pipeline.id}: roleRef/scriptRef "${roleId}" must be listed in required_roles (route binding)`,
      );
      assert.ok(
        declaredRoleIds.has(roleId),
        `${pipeline.id}: role "${roleId}" must be declared in the roles catalog`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// 4. seedDefaultPlaybook idempotency + benign-race tolerance.
// ---------------------------------------------------------------------------
const STUB_RESULT: PlaybookInstallResult = {
  playbookId: DEFAULT_PLAYBOOK_ID,
  name: 'Revisium Default Playbook',
  version: '0.1.0',
  source: 'local:default',
  roles: 6,
  pipelines: 2,
  operations: [],
  committed: true,
  dryRun: false,
};

test('seedDefaultPlaybook: installs when the default playbook is absent', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed');
  assert.equal(installs, 1);
});

test('seedDefaultPlaybook: skips when the default playbook is already installed', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed');
  assert.equal(installs, 0, 'must not re-install an existing playbook');
});

test('seedDefaultPlaybook: tolerates a benign concurrent-commit race', async () => {
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { throw new Error('revision is not a draft'); },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'raced');
});

test('seedDefaultPlaybook: rethrows a non-benign install failure', async () => {
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { throw new Error('PLAYBOOK_INVALID_CATALOG: boom'); },
  };
  await assert.rejects(() => seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE), /PLAYBOOK_INVALID_CATALOG/);
});

test('seedDefaultPlaybook: throws a clear error when the source directory is missing', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const missing = join(DEFAULT_PLAYBOOK_SOURCE, '__does_not_exist__');
  await assert.rejects(
    () => seedDefaultPlaybook(installer, missing),
    /default playbook source not found/,
  );
  assert.equal(installs, 0, 'must not attempt an install when the source is absent');
});

// ---------------------------------------------------------------------------
// 5. createDaemonInstaller wires the live-daemon adapter (presence reader + real installer).
// ---------------------------------------------------------------------------
test('createDaemonInstaller: forwards listPlaybooks and exposes an install function', async () => {
  const present = [{ id: DEFAULT_PLAYBOOK_ID }];
  const installer = createDaemonInstaller(async () => present);
  assert.equal(typeof installer.install, 'function', 'install is backed by the real PlaybookInstaller');
  assert.deepEqual(await installer.listPlaybooks(), present, 'listPlaybooks delegates to the injected reader');
});

test('createDaemonInstaller: seed skips install when the reader reports the default present', async () => {
  // Drives seedDefaultPlaybook through the daemon adapter's listPlaybooks without touching a daemon:
  // the presence reader short-circuits before install() (which WOULD need the live draft scope).
  const installer = createDaemonInstaller(async () => [{ id: DEFAULT_PLAYBOOK_ID }]);
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed');
});
