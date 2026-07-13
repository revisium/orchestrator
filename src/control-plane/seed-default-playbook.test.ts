/**
 * seed-default-playbook.test.ts — slice 5 (plan 0015)
 *
 * Proves the BUILT-IN DEFAULT playbook (control-plane/default-playbook/) is shippable WITHOUT a live
 * daemon and that the seed install is idempotent. Distinct from the e2e fixture playbook — this is the
 * artifact host bootstrap installs out-of-the-box.
 *
 * Assertions:
 *   1. The default playbook installs via the REAL PlaybookInstaller (fake access) as `revisium-default`
 *      with the expected roles, pipelines, and launch profiles.
 *   2. Every pipeline carries a data-driven `template_json` that passes `pipeline-core.validateTemplate`
 *      (zero errors) — the authoritative validator.
 *   3. Every executable `roleRef`/`scriptRef` a template references is covered by the role catalog or
 *      an explicit built-in script rule; the graph, not a pipeline role list, owns obligations.
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
import { materializeTemplate } from '../pipeline-core/materialize.js';
import {
  seedDefaultPlaybook,
  bundledCatalogHash,
  DEFAULT_PLAYBOOK_ID,
  DEFAULT_PLAYBOOK_SOURCE,
  type DefaultPlaybookInstaller,
} from './seed-default-playbook.js';
import type { PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { scopedRunProfileRowId } from '../playbook/import-mapper.js';
import { topologyProfileFromRunProfile } from './run-profiles.js';

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
    async retireMissingRows() {
      return [];
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
test('default playbook: installs as revisium-default with launchable pipelines and seeded run profiles', async () => {
  const fake = fakeAccess();
  const installer = new PlaybookInstaller({ access: fake.access });
  const result = await installer.install({
    source: DEFAULT_PLAYBOOK_SOURCE,
    name: DEFAULT_PLAYBOOK_ID,
    commit: true,
  });

  assert.equal(result.playbookId, DEFAULT_PLAYBOOK_ID);
  assert.equal(result.committed, true);
  assert.equal(result.roles, 7, `expected exactly 7 logical default roles (got ${result.roles})`);
  assert.equal(result.pipelines, 3, 'feature-development + local-change + analysis-only');
  assert.equal(result.runProfiles, 8, 'built-in run profiles for all launchable pipelines');

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
    pipelineRowIds.includes('revisium-default-analysis-only'),
    'analysis-only pipeline row is written (scoped by playbook id)',
  );

  const profileRowIds = fake.rows.filter((r) => r.table === 'run_profiles').map((r) => r.rowId);
  const expectedProfileRowIds = runProfiles.map((profile) =>
    scopedRunProfileRowId(DEFAULT_PLAYBOOK_ID, profile.pipelineId, profile.id),
  );
  assert.deepEqual(profileRowIds.sort(), expectedProfileRowIds.sort());
});

// ---------------------------------------------------------------------------
// 2 + 3. Every pipeline template validates AND its executable graph handles resolve to meaning rows.
// ---------------------------------------------------------------------------
type PipelineCatalogEntry = {
  id: string;
  triggers?: string[];
  route_gates?: string[];
  execution_policy: { template_json?: unknown };
};
type RunProfileCatalogEntry = {
  id: string;
  pipelineId: string;
  topology: unknown;
  bindings: unknown;
  status: string;
};

const catalogDir = join(DEFAULT_PLAYBOOK_SOURCE, 'catalog');
const pipelines = JSON.parse(
  readFileSync(join(catalogDir, 'pipelines.json'), 'utf8'),
) as PipelineCatalogEntry[];
const runProfiles = JSON.parse(
  readFileSync(join(catalogDir, 'run-profiles.json'), 'utf8'),
) as RunProfileCatalogEntry[];
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
  // Built-in system scripts share the integrator route binding instead of declaring separate roles.
  const BUILT_IN_SCRIPTS = new Set(['integrator', 'confirmMerge', 'pollPr', 'overrideMerge', 'respondThreads']);
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

test('default playbook: consensus launch shapes are catalog data, not pipeline rows', () => {
  assert.equal(
    pipelines.some((pipeline) => pipeline.id.includes('consensus')),
    false,
    'consensus launch shapes are not public pipeline rows',
  );
  assert.deepEqual(runProfiles.map((profile) => profile.id).sort(), [
    'analysis-only-claude-opus-4-8',
    'analysis-only-codex-gpt-5-6-luna',
    'claude-opus-4-8-codex-gpt-5-6-luna-consensus',
    'claude-opus-sonnet',
    'codex-gpt-5-6-luna',
    'codex-gpt-5-6-luna-claude-opus-4-8-consensus',
    'local-change-claude-sonnet-4-6',
    'local-change-codex-gpt-5-6-luna',
  ]);
  const expectedPipelineByProfile = new Map([
    ['analysis-only-claude-opus-4-8', 'analysis-only'],
    ['analysis-only-codex-gpt-5-6-luna', 'analysis-only'],
    ['claude-opus-4-8-codex-gpt-5-6-luna-consensus', 'feature-development'],
    ['claude-opus-sonnet', 'feature-development'],
    ['codex-gpt-5-6-luna-claude-opus-4-8-consensus', 'feature-development'],
    ['codex-gpt-5-6-luna', 'feature-development'],
    ['local-change-claude-sonnet-4-6', 'local-change'],
    ['local-change-codex-gpt-5-6-luna', 'local-change'],
  ]);
  for (const profile of runProfiles) {
    assert.equal(profile.pipelineId, expectedPipelineByProfile.get(profile.id), `${profile.id} is scoped to its pipeline`);
    assert.equal(profile.status, 'active', `${profile.id} is active`);
  }
});

test('default playbook: materialized consensus profile fans out plan + code review with canonical role refs', () => {
  const base = pipelines.find((p) => p.id === 'feature-development')?.execution_policy?.template_json;
  assert.ok(base, 'feature-development carries execution_policy.template_json');
  const profile = runProfiles.find((item) => item.id === 'codex-gpt-5-6-luna-claude-opus-4-8-consensus');
  assert.ok(profile, 'codex-gpt-5-6-luna-claude-opus-4-8-consensus profile exists');
  const { template: materialized, diagnostics } = materializeTemplate(
    base as never,
    topologyProfileFromRunProfile(profile as never),
    { allowlist: ['planReviewer', 'codeReview'] },
  );
  assert.deepEqual(diagnostics, [], 'materializeTemplate must emit no diagnostics');

  const nodes = materialized.nodes as Record<string, Record<string, unknown>>;

  assert.equal(nodes['analyst']?.next, 'planReviewFanout');
  assert.deepEqual(nodes['planReviewFanout']?.branches, [
    { id: 'primary', entry: 'planReviewPrimary' },
    { id: 'secondary', entry: 'planReviewSecondary' },
  ]);
  assert.equal(nodes['planReviewFanout']?.join, 'planReviewJoin');
  assert.equal(nodes['planReviewPrimary']?.roleRef, 'role:reviewer');
  assert.equal(nodes['planReviewSecondary']?.roleRef, 'role:reviewer');
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
  assert.equal(nodes['codeReviewPrimary']?.roleRef, 'role:reviewer');
  assert.equal(nodes['codeReviewSecondary']?.roleRef, 'role:reviewer');
  assert.equal(nodes['codeReviewJoin']?.next, 'codeReviewRouter');
  assert.deepEqual(nodes['codeReviewJoin']?.verdictReducer, {
    kind: 'allIn',
    pass: ['approved', 'clean'],
    passVerdict: 'approved',
    failVerdict: 'changes_requested',
  });
});

test('default playbook: developer prompt is working-tree only and contains no publication vocabulary', () => {
  const prompt = readFileSync(join(DEFAULT_PLAYBOOK_SOURCE, 'prompts', 'developer.md'), 'utf8');

  assert.match(prompt, /task working tree/i, 'developer scope must name the task working tree');
  assert.doesNotMatch(
    prompt,
    /\bPRs?\b|\bpull request\b|\bpush(?:es|ed|ing)?\b|\bship(?:s|ped|ping)?\b|\bcommits?\b|\bcommitting\b|\bgh\b|\bGitHub\b/i,
    'developer prompt must not teach publication vocabulary',
  );
});

test('default playbook: bootstrap has no model catalog and catalogs keep launch authority separate', () => {
  assert.equal((bootstrapSeed.rows ?? []).some((row) => row.tableId === 'model_profiles'), false);
  const roleRecords = roleCatalog as Array<Record<string, unknown>>;
  assert.equal(roleRecords.some((role) => 'default_model_level' in role || 'runner_id' in role || 'model_level' in role), false);
  assert.equal(pipelines.some((pipeline) => 'required_roles' in pipeline || 'optional_roles' in pipeline || 'alternative_roles' in pipeline), false);
});

test('default playbook: stuck code-review gates surface the latest code-change artifact', () => {
  const template = pipelineTemplate('feature-development') as {
    nodes?: Record<string, { gatedArtifact?: { node?: string; as?: string } }>;
  };
  const gatedArtifact = template.nodes?.['codeStuckGate']?.gatedArtifact;

  assert.deepEqual(
    gatedArtifact,
    { node: 'reworkDeveloper', as: 'change' },
    'feature-development codeStuckGate must show the code change, not the plan',
  );
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

  test(`default playbook: ${pipeline.id} graph executable obligations are covered by the meaning catalog`, () => {
    const template = pipeline.execution_policy.template_json as {
      nodes: Record<string, Record<string, unknown>>;
    };
    for (const roleId of capabilityRoleIds(template)) {
      if (roleId === 'integrator') continue;
      assert.ok(declaredRoleIds.has(roleId), `${pipeline.id}: role "${roleId}" must be declared in the roles catalog`);
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
    ['approved', 'clean', 'blocker', 'changes_requested', 'review_changes', 'ci_changes', 'fix', 'wontfix', 'question', 'recheck', 'approve_anyway', 'rework', 'cancel', 'address_review_threads', 'return_to_development', 'override_merge', 'merged', 'closed'],
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
  roles: 7,
  pipelines: 3,
  runProfiles: 8,
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

test('seedDefaultPlaybook: re-seeds when an installed row has no catalogHash', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed');
  assert.equal(installs, 1, 'missing hash is not considered up to date');
});

test('seedDefaultPlaybook: logs the up-to-date decision when skipping', async () => {
  const messages: string[] = [];
  let installs = 0;
  const catalogHash = bundledCatalogHash(DEFAULT_PLAYBOOK_SOURCE);
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: BUNDLED_DEFAULT_VERSION, catalogHash }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE, (m) => messages.push(m));
  assert.equal(outcome.status, 'already-installed');
  assert.equal(installs, 0);
  assert.ok(
    messages.some((m) => /unchanged|skipping seed/i.test(m)),
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
    messages.some((m) => /no catalog hash/i.test(m)),
    'the no-hash re-seed decision is logged for the operator',
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

test('seedDefaultPlaybook: re-seeds when catalogHash is absent', async () => {
  let installs = 0;
  const installer: DefaultPlaybookInstaller = {
    async listPlaybooks() { return [{ id: DEFAULT_PLAYBOOK_ID, version: '0.0.1' }]; },
    async install() { installs += 1; return STUB_RESULT; },
  };
  const outcome = await seedDefaultPlaybook(installer, DEFAULT_PLAYBOOK_SOURCE);
  assert.equal(outcome.status, 'installed', 'missing hash should re-seed');
  assert.equal(installs, 1);
});
