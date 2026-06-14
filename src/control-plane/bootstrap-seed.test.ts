/**
 * bootstrap-seed.test.ts — T1 (slice 0007)
 *
 * Verifies the seed in control-plane/bootstrap.config.json satisfies
 * loadRole / loadModelProfile without a live daemon.
 *
 * Assertions:
 *   1. Each dispatched role (architect/developer/reviewer) and integrator
 *      resolves via loadRole with the expected runner + model_level.
 *   2. Every model_level referenced by those roles has a matching
 *      model_profiles seed row that resolves via loadModelProfile.
 *   3. Referential integrity: each role's model_level has a profile row.
 *   4. Uniqueness: rowId is unique per tableId (no duplicate seed entries).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRole, loadModelProfile, loadPipelinePolicy } from './definitions.js';
import type { ControlPlaneTransport } from './client-transport.js';
import type { TransportRow } from './client-transport.js';

// ---------------------------------------------------------------------------
// Load the real seed file the same way bootstrap.ts does:
//   repoRoot = resolve(dirname(import.meta.url), '..')  (dist/config.js → pkg root)
// In this test we are in src/control-plane/, so repoRoot is two levels up.
// ---------------------------------------------------------------------------
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '..', '..');
const seedPath = resolve(repoRoot, 'control-plane', 'bootstrap.config.json');

type SeedRow = {
  tableId: string;
  rowId: string;
  data: Record<string, unknown>;
};

type SeedTable = {
  id: string;
  schema: { properties?: Record<string, unknown> };
};

type SeedConfig = {
  rows: SeedRow[];
  tables: SeedTable[];
};

const seed = JSON.parse(readFileSync(seedPath, 'utf8')) as SeedConfig;
const seedRows: SeedRow[] = seed.rows ?? [];
const seedTables: SeedTable[] = seed.tables ?? [];

function tableProps(tableId: string): Record<string, unknown> {
  const t = seedTables.find((x) => x.id === tableId);
  return t?.schema?.properties ?? {};
}

// ---------------------------------------------------------------------------
// In-memory transport: keyed by "tableId/rowId", returns { id, data }
// Mirrors the pattern from definitions.test.ts.
// ---------------------------------------------------------------------------
function makeSeedTransport(): ControlPlaneTransport {
  const store = new Map<string, Record<string, unknown>>();
  for (const row of seedRows) {
    store.set(`${row.tableId}/${row.rowId}`, row.data);
  }
  return {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() { return { edges: [] }; },
    async getRow(table: string, rowId: string): Promise<TransportRow> {
      const data = store.get(`${table}/${rowId}`);
      if (!data) {
        const err = Object.assign(new Error(`seed row not found: ${table}/${rowId}`), { statusCode: 404 });
        throw err;
      }
      return { id: rowId, data };
    },
    async createRow() { throw new Error('read-only'); },
    async updateRow() { throw new Error('read-only'); },
    async patchRow() { throw new Error('read-only'); },
  };
}

const transport = makeSeedTransport();

// ---------------------------------------------------------------------------
// The roles that must resolve for the fixed pipeline (dispatched + validated).
// ---------------------------------------------------------------------------
const DISPATCHED_ROLES = ['architect', 'developer', 'reviewer'] as const;
const ALL_REQUIRED_ROLES = [...DISPATCHED_ROLES, 'integrator'] as const;

const EXPECTED_RUNNERS: Record<string, string> = {
  architect: 'claude-code',
  developer: 'claude-code',
  reviewer: 'claude-code',
  integrator: 'script',
};

const EXPECTED_MODEL_LEVELS: Record<string, string> = {
  architect: 'deep',
  developer: 'standard',
  reviewer: 'standard',
  integrator: 'standard',
};

// ---------------------------------------------------------------------------
// T1-a: each required role resolves via loadRole with no throw.
// ---------------------------------------------------------------------------
for (const roleName of ALL_REQUIRED_ROLES) {
  test(`seed: loadRole('${roleName}') resolves with expected runner and model_level`, async () => {
    const role = await loadRole(roleName, transport);
    assert.ok(role.name.length > 0, `${roleName}: name must be non-empty`);
    assert.equal(role.runner, EXPECTED_RUNNERS[roleName], `${roleName}: unexpected runner`);
    assert.equal(role.modelLevel, EXPECTED_MODEL_LEVELS[roleName], `${roleName}: unexpected model_level`);
    assert.ok(Array.isArray(role.allowedTools), `${roleName}: allowed_tools must be an array`);
    // scope_rules must parse as an object (parseJsonField yields {} or parsed value)
    assert.equal(typeof role.scopeRules, 'object', `${roleName}: scope_rules must parse as an object`);
  });
}

// ---------------------------------------------------------------------------
// T1-b: each model_level referenced by the required roles resolves via loadModelProfile.
// ---------------------------------------------------------------------------
const referencedLevels = new Set(Object.values(EXPECTED_MODEL_LEVELS));

for (const level of referencedLevels) {
  test(`seed: loadModelProfile('${level}') resolves with non-empty model_id`, async () => {
    const profile = await loadModelProfile(level, transport);
    assert.ok(profile.modelId.length > 0, `${level}: model_id must be non-empty`);
    assert.ok(profile.provider.length > 0, `${level}: provider must be non-empty`);
    assert.equal(typeof profile.params, 'object', `${level}: params must parse as an object`);
    assert.ok(typeof profile.costPerInput === 'number', `${level}: cost_per_input must be numeric`);
    assert.ok(typeof profile.costPerOutput === 'number', `${level}: cost_per_output must be numeric`);
  });
}

// ---------------------------------------------------------------------------
// T1-c: referential integrity — each required role's model_level has a profile row in the seed.
// ---------------------------------------------------------------------------
test('seed: referential integrity — each required role model_level has a matching model_profiles row', () => {
  const profileRowIds = new Set(
    seedRows
      .filter((r) => r.tableId === 'model_profiles')
      .map((r) => r.rowId),
  );
  for (const roleName of ALL_REQUIRED_ROLES) {
    const expectedLevel = EXPECTED_MODEL_LEVELS[roleName];
    assert.ok(
      profileRowIds.has(expectedLevel),
      `model_profiles row '${expectedLevel}' (for role '${roleName}') is missing from the seed`,
    );
  }
});

// ---------------------------------------------------------------------------
// 0008 #5: params-as-data — roles carry timeout_ms/permission_mode; routing_policy
// holds the pipeline limits; attempts schema carries the observability fields.
// ---------------------------------------------------------------------------
test('seed (0008 #5): roles schema declares timeout_ms + permission_mode', () => {
  const props = tableProps('roles');
  assert.ok('timeout_ms' in props, 'roles.timeout_ms must be declared');
  assert.ok('permission_mode' in props, 'roles.permission_mode must be declared');
});

test('seed (0009): playbook import schema is declared as versioned meaning', () => {
  const playbooks = tableProps('playbooks');
  const pipelines = tableProps('pipelines');
  const roles = tableProps('roles');

  for (const field of ['source', 'version', 'schema_version', 'catalog_hash']) {
    assert.ok(field in playbooks, `playbooks.${field} must be declared`);
  }
  for (const field of ['playbook_id', 'pipeline_id', 'execution_policy_json']) {
    assert.ok(field in pipelines, `pipelines.${field} must be declared`);
  }
  for (const field of ['playbook_id', 'playbook_role_id', 'source_path', 'source_hash', 'surface', 'rights']) {
    assert.ok(field in roles, `roles.${field} must be declared`);
  }
  assert.ok('runner_id' in roles, 'roles.runner_id must be declared');
  const taskRuns = tableProps('task_runs');
  for (const field of ['playbook_id', 'pipeline_id', 'params', 'route_decision', 'execution_profile']) {
    assert.ok(field in taskRuns, `task_runs.${field} must be declared`);
  }
});

test('seed (0008 #5): loadRole surfaces per-role timeout_ms + permission_mode', async () => {
  const architect = await loadRole('architect', transport);
  assert.equal(architect.timeoutMs, 1200000, 'architect timeout_ms must resolve from the seed');
  assert.equal(architect.permissionMode, 'default', 'architect permission_mode must resolve from the seed');
});

test('seed (0008 #5): loadPipelinePolicy resolves the routing_policy "pipeline" row', async () => {
  const policy = await loadPipelinePolicy(transport);
  assert.equal(policy.maxReviewIterations, 3, 'max_review_iterations must come from the seed');
  assert.equal(policy.maxAttempts, 3, 'max_attempts must come from the seed');
  assert.equal(policy.budgetUsd, 0, 'budget_usd defaults to 0 (unlimited)');
  assert.equal(policy.budgetTokens, 0, 'budget_tokens defaults to 0 (unlimited)');
});

test('seed (0008 #5): loadPipelinePolicy falls back to defaults when the row is absent', async () => {
  const policy = await loadPipelinePolicy(transport, 'does-not-exist');
  assert.equal(policy.maxReviewIterations, 3);
  assert.equal(policy.maxAttempts, 3);
});

test('seed (0008 #4): attempts schema declares the observability fields', () => {
  const props = tableProps('attempts');
  for (const field of ['iteration', 'verdict', 'cost_amount', 'duration_ms', 'output_summary']) {
    assert.ok(field in props, `attempts.${field} must be declared for observability`);
  }
});

// ---------------------------------------------------------------------------
// T1-d: uniqueness — rowId is unique per tableId (prevents bootstrap duplicates).
// ---------------------------------------------------------------------------
test('seed: rowId is unique per tableId (no duplicate seed entries)', () => {
  const seen = new Map<string, Set<string>>();
  for (const row of seedRows) {
    const existing = seen.get(row.tableId);
    if (existing) {
      assert.ok(
        !existing.has(row.rowId),
        `Duplicate seed entry: tableId='${row.tableId}' rowId='${row.rowId}'`,
      );
      existing.add(row.rowId);
    } else {
      seen.set(row.tableId, new Set([row.rowId]));
    }
  }
});
