/**
 * seed-default-playbook.test.ts — slice 5 (plan 0015)
 *
 * Proves the BUILT-IN DEFAULT playbook (control-plane/default-playbook/) is shippable WITHOUT a live
 * daemon and that the seed install is idempotent. Distinct from the e2e fixture playbook — this is the
 * artifact `revo bootstrap` installs out-of-the-box.
 *
 * Assertions:
 *   1. The default playbook installs via the REAL PlaybookInstaller (fake access) as `revisium-default`
 *      with the expected roles + pipelines (feature-development, feature-development-codex-consensus,
 *      and local-change).
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
  bundledCatalogHash,
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
test('default playbook: installs as revisium-default with feature-development + codex-consensus + local-change', async () => {
  const fake = fakeAccess();
  const installer = new PlaybookInstaller({ access: fake.access });
  const result = await installer.install({
    source: DEFAULT_PLAYBOOK_SOURCE,
    name: DEFAULT_PLAYBOOK_ID,
    commit: true,
  });

  assert.equal(result.playbookId, DEFAULT_PLAYBOOK_ID);
  assert.equal(result.committed, true);
  assert.equal(result.roles, 13, `expected exactly 13 default roles (got ${result.roles})`);
  assert.equal(result.pipelines, 3, 'feature-development + feature-development-codex-consensus + local-change');

  const pipelineRowIds = fake.rows.filter((r) => r.table === 'pipelines').map((r) => r.rowId);
  assert.ok(
    pipelineRowIds.includes('revisium-default-feature-development'),
    'feature-development pipeline row is written (scoped by playbook id)',
  );
  assert.ok(
    pipelineRowIds.includes('revisium-default-local-change'),
    'local-change pipeline row is written (scoped by playbook id)',
  );
  assert.ok(
    pipelineRowIds.includes('revisium-default-feature-development-codex-consensus'),
    'Codex consensus feature-development pipeline row is written (scoped by playbook id)',
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
const bootstrapSeed = JSON.parse(
  readFileSync(join(DEFAULT_PLAYBOOK_SOURCE, '..', 'bootstrap.config.json'), 'utf8'),
) as { rows?: Array<{ tableId: string; rowId: string }> };

function pipelineTemplate(id: string): { verdicts?: { domain?: unknown } } {
  const pipeline = pipelines.find((candidate) => candidate.id === id);
  assert.ok(pipeline, `default pipeline ${id} exists`);
  const template = pipeline.execution_policy.template_json;
  assert.ok(template, `default pipeline ${id} carries execution_policy.template_json`);
  return template as { verdicts?: { domain?: unknown } };
}

/** Walk a template's nodes and collect every `<kind>:<id>` capability handle referenced. */
function capabilityRoleIds(template: { nodes: Record<string, Record<string, unknown>> }): string[] {
  // Built-in system scripts have no role of their own — they resolve to whichever binding runs the
  // merge (the `integrator` required role): `script:integrator` (open PR), `script:confirmMerge`
  // (verify/auto-merge, plan 0017), and the plan 0018 PR review-feedback scripts `script:pollPr`
  // (observe/classify) + `script:respondThreads` (reply/resolve). Map them to `integrator` (runner-wins)
  // so the coverage check is satisfied.
  const BUILT_IN_SCRIPTS = new Set(['integrator', 'confirmMerge', 'pollPr', 'respondThreads']);
  // Engine-handled scripts that need no role binding at all — skip them from the coverage check.
  const ROLE_FREE_SCRIPTS = new Set(['cleanupWorktree']);
  const ids = new Set<string>();
  for (const node of Object.values(template.nodes)) {
    for (const key of ['roleRef', 'scriptRef'] as const) {
      const ref = node[key];
      // A handle is `role:<id>` / `script:<id>`; the engine resolves the suffix against role bindings.
      if (typeof ref === 'string' && ref.includes(':')) {
        const suffix = ref.slice(ref.indexOf(':') + 1);
        if (ref.startsWith('script:') && ROLE_FREE_SCRIPTS.has(suffix)) continue;
        ids.add(ref.startsWith('script:') && BUILT_IN_SCRIPTS.has(suffix) ? 'integrator' : suffix);
      }
    }
  }
  return [...ids];
}

test('default playbook: Codex consensus pipeline is Codex-bound and fans out plan + code review', () => {
  const pipeline = pipelines.find((item) => item.id === 'feature-development-codex-consensus');
  assert.ok(pipeline, 'feature-development-codex-consensus is declared');
  assert.deepEqual(pipeline.required_roles, [
    'orchestrator-codex',
    'analyst-codex',
    'reviewer-codex',
    'triager-codex',
    'developer-codex',
    'integrator',
    'watcher-codex',
  ]);

  const roles = new Map(
    (roleCatalog as Array<{ id: string; runner_id?: string; default_model_level?: string }>).map((role) => [role.id, role]),
  );
  for (const roleId of ['orchestrator-codex', 'analyst-codex', 'reviewer-codex', 'triager-codex', 'developer-codex', 'watcher-codex']) {
    const role = roles.get(roleId);
    assert.equal(role?.runner_id, 'codex', `${roleId} runs on Codex`);
    assert.match(role?.default_model_level ?? '', /^codex-/, `${roleId} uses a Codex-compatible model profile`);
  }

  const template = pipeline.execution_policy.template_json as { nodes: Record<string, Record<string, unknown>>; pipelineId?: string };
  const nodes = template.nodes;
  assert.equal(template.pipelineId, 'feature-development-codex-consensus');
  assert.equal(nodes['analyst']?.roleRef, 'role:analyst-codex');
  assert.equal(nodes['developer']?.roleRef, 'role:developer-codex');
  assert.equal(nodes['reworkDeveloper']?.roleRef, 'role:developer-codex');
  assert.equal(nodes['ciRework']?.roleRef, 'role:developer-codex');
  assert.equal(nodes['reviewRework']?.roleRef, 'role:developer-codex');
  assert.equal(nodes['triage']?.roleRef, 'role:triager-codex');

  assert.equal(nodes['analyst']?.next, 'planReviewFanout');
  assert.deepEqual(nodes['planReviewFanout']?.branches, [
    { id: 'primary', entry: 'planReviewPrimary' },
    { id: 'secondary', entry: 'planReviewSecondary' },
  ]);
  assert.equal(nodes['planReviewFanout']?.join, 'planReviewJoin');
  assert.equal(nodes['planReviewPrimary']?.roleRef, 'role:reviewer-codex');
  assert.equal(nodes['planReviewSecondary']?.roleRef, 'role:reviewer-codex');
  assert.equal(nodes['planReviewJoin']?.next, 'planReviewRouter');
  assert.deepEqual(nodes['planReviewJoin']?.verdictReducer, {
    kind: 'allIn',
    pass: ['approved', 'clean'],
    passVerdict: 'approved',
    failVerdict: 'changes_requested',
  });

  assert.equal(nodes['developer']?.next, 'codeReviewFanout');
  assert.equal(nodes['reworkDeveloper']?.next, 'codeReviewFanout');
  assert.deepEqual(nodes['codeReviewFanout']?.branches, [
    { id: 'primary', entry: 'codeReviewPrimary' },
    { id: 'secondary', entry: 'codeReviewSecondary' },
  ]);
  assert.equal(nodes['codeReviewFanout']?.join, 'codeReviewJoin');
  assert.equal(nodes['codeReviewPrimary']?.roleRef, 'role:reviewer-codex');
  assert.equal(nodes['codeReviewSecondary']?.roleRef, 'role:reviewer-codex');
  assert.equal(nodes['codeReviewJoin']?.next, 'codeReviewRouter');
  assert.deepEqual(nodes['codeReviewJoin']?.verdictReducer, {
    kind: 'allIn',
    pass: ['approved', 'clean'],
    passVerdict: 'approved',
    failVerdict: 'changes_requested',
  });
});

test('default playbook: every role model level has a bootstrap model profile', () => {
  const profileRowIds = new Set(
    (bootstrapSeed.rows ?? [])
      .filter((row) => row.tableId === 'model_profiles')
      .map((row) => row.rowId),
  );
  const modelLevels = new Set(
    (roleCatalog as Array<{ default_model_level?: string }>)
      .map((role) => role.default_model_level)
      .filter((level): level is string => typeof level === 'string' && level.length > 0),
  );

  for (const modelLevel of modelLevels) {
    assert.ok(profileRowIds.has(modelLevel), `bootstrap model_profiles row is missing for default model level ${modelLevel}`);
  }
});

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

test('default playbook: feature-development wires cleanupWorktree after confirmMerge, local-change has no cleanup', () => {
  type NodeMap = Record<string, { kind?: string; scriptRef?: string; next?: string }>;
  const featureTemplate = pipelineTemplate('feature-development') as unknown as { nodes: NodeMap };
  const localTemplate = pipelineTemplate('local-change') as unknown as { nodes: NodeMap };
  const nodes = featureTemplate.nodes;
  assert.ok(nodes['cleanupWorktree'], 'feature-development has a cleanupWorktree node');
  assert.equal(nodes['cleanupWorktree'].kind, 'script', 'cleanupWorktree is a script node');
  assert.equal(nodes['cleanupWorktree'].scriptRef, 'script:cleanupWorktree');
  assert.equal(nodes['cleanupWorktree'].next, 'mergedEnd', 'cleanupWorktree leads to mergedEnd');
  assert.equal(nodes['confirmMerge']?.next, 'cleanupWorktree', 'confirmMerge.next is cleanupWorktree');
  const localNodes = localTemplate.nodes;
  const hasCleanup = Object.values(localNodes).some((n) => n.scriptRef === 'script:cleanupWorktree');
  assert.equal(hasCleanup, false, 'local-change has no cleanupWorktree — recoverable worktree is preserved');
});

test('default playbook: verdict domains preserve local-change narrowness and feature-development breadth', () => {
  assert.deepEqual(
    pipelineTemplate('local-change').verdicts?.domain,
    ['approved'],
    'local-change must stay narrow; runner prompts adapt to this domain instead of widening it',
  );
  assert.deepEqual(
    pipelineTemplate('feature-development').verdicts?.domain,
    ['approved', 'clean', 'blocker', 'changes_requested', 'review_changes', 'ci_changes', 'fix', 'wontfix', 'question', 'recheck'],
    'feature-development keeps the broad default domain used by plan/review/PR-feedback routing',
  );
});

// ---------------------------------------------------------------------------
// 4. seedDefaultPlaybook idempotency + benign-race tolerance.
// ---------------------------------------------------------------------------
const STUB_RESULT: PlaybookInstallResult = {
  playbookId: DEFAULT_PLAYBOOK_ID,
  name: 'Revisium Default Playbook',
  version: '0.1.0',
  source: 'local:default',
  roles: 13,
  pipelines: 3,
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

/**
 * The bundled default-playbook version — the value `resolvePlaybookSource` reads from the source
 * package.json. The version-aware re-seed (slice 144) compares the installed row's version against this,
 * so the idempotency tests pin the installed version to the bundle to express "up to date".
 */
const BUNDLED_DEFAULT_VERSION = JSON.parse(
  readFileSync(join(DEFAULT_PLAYBOOK_SOURCE, 'package.json'), 'utf8'),
).version as string;

test('seedDefaultPlaybook: skips when the installed version equals the bundled version', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed');
  assert.equal(installs, 0, 'must not re-install when versions match');
});

test('seedDefaultPlaybook: skips when the installed version is NEWER than the bundle (never downgrade)', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: '99.0.0' }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed');
  assert.equal(installs, 0, 'must not downgrade to an older bundle');
});

test('seedDefaultPlaybook: re-seeds when the bundle is NEWER than the installed version', async () => {
  // 0.0.1 is below any plausible bundled release version, so the bundle always wins the semver compare.
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: '0.0.1' }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed', 'a newer bundle overwrites the installed playbook');
  assert.equal(installs, 1);
});

test('seedDefaultPlaybook: re-seeds once when the installed row has NO recorded version', async () => {
  // Backward-compat: a pre-versioning install reads as "older" so the one-time upgrade lands.
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed', 'a versionless installed row is treated as older → re-seed');
  assert.equal(installs, 1);
});

test('seedDefaultPlaybook: logs the up-to-date decision when skipping', async () => {
  const messages: string[] = [];
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION }]; },
    async install() { return STUB_RESULT; },
  };
  await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE, (m) => messages.push(m));
  assert.ok(
    messages.some((m) => /up to date/i.test(m)),
    'the skip decision is logged for the operator',
  );
});

test('seedDefaultPlaybook: logs the re-seed decision when the bundle is newer', async () => {
  const messages: string[] = [];
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: '0.0.1' }]; },
    async install() { return STUB_RESULT; },
  };
  await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE, (m) => messages.push(m));
  assert.ok(
    messages.some((m) => /re-seed/i.test(m)),
    'the re-seed decision is logged for the operator',
  );
});

test('seedDefaultPlaybook: tolerates a benign concurrent-commit race', async () => {
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { throw new Error('revision is not a draft'); },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'raced');
});

test('seedDefaultPlaybook: tolerates a benign race thrown as a non-Error value', async () => {
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return []; },
    async install() { throw 'revision is not a draft'; },
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
// 4b. Hash-based re-seed decision (B1 content-fingerprint path).
// ---------------------------------------------------------------------------

test('seedDefaultPlaybook: re-seeds when catalogHash is stale (exact version match is not enough)', async () => {
  // This is the core B1 bug: same version, different content → must re-seed.
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() {
      return [{ id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION, catalogHash: 'stale-hash' }];
    },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed', 'stale hash must trigger re-seed even when version equals bundle');
  assert.equal(installs, 1);
});

test('seedDefaultPlaybook: skips when catalogHash matches (older version but identical content)', async () => {
  // Identical content → skip, even if the installed version is older than the bundle.
  let installs = 0;
  const currentHash = bundledCatalogHash(DEFAULT_PLAYBOOK_SOURCE);
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() {
      return [{ id: DEFAULT_PLAYBOOK_ID, version: '0.0.1', catalogHash: currentHash }];
    },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed', 'matching hash must skip re-seed regardless of version');
  assert.equal(installs, 0, 'must not call install when content is identical');
});

test('seedDefaultPlaybook: falls back to version compare when catalogHash is absent (legacy row)', async () => {
  // A row without catalogHash exercises the version-compare path, not the hash path.
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    // version '0.0.1' is older than any bundle version → version fallback triggers re-seed
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: '0.0.1' }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed', 'legacy row with old version should re-seed via version compare');
  assert.equal(installs, 1);
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

test('createDaemonInstaller: seed skips install when the reader reports an up-to-date default present', async () => {
  // Drives seedDefaultPlaybook through the daemon adapter's listPlaybooks without touching a daemon:
  // an up-to-date version short-circuits before install() (which WOULD need the live draft scope).
  const installer = createDaemonInstaller(async () => [
    { id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION },
  ]);
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'already-installed');
});
