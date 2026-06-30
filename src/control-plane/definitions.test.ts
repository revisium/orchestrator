import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRole, loadModelProfile, loadPipelinePolicy } from './definitions.js';
import { ControlPlaneError } from './errors.js';
import type { ControlPlaneTransport } from './client-transport.js';

function makeTransport(rows: Record<string, Record<string, unknown>>): ControlPlaneTransport {
  return {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() { return { edges: [] }; },
    async getRow(table, rowId) {
      const key = `${table}/${rowId}`;
      const data = rows[key];
      if (!data) {
        const err = Object.assign(new Error(`not found: ${key}`), { statusCode: 404 });
        throw err;
      }
      return { id: rowId, data };
    },
    async createRow() { throw new Error('read-only'); },
    async updateRow() { throw new Error('read-only'); },
    async patchRow() { throw new Error('read-only'); },
  };
}

test('loadRole: deserializes a roles row', async () => {
  const transport = makeTransport({
    'roles/architect': {
      id: 'architect',
      name: 'architect',
      system_prompt: 'Plan the work.',
      model_level: 'standard',
      effort: 'high',
      runner: 'claude-code',
      allowed_tools: ['read', 'write'],
      scope_rules: '{"allow":["src"]}',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('architect', transport);

  assert.equal(role.name, 'architect');
  assert.equal(role.systemPrompt, 'Plan the work.');
  assert.equal(role.modelLevel, 'standard');
  assert.equal(role.effort, 'high');
  assert.equal(role.runner, 'claude-code');
  assert.deepEqual(role.allowedTools, ['read', 'write']);
  assert.deepEqual(role.scopeRules, { allow: ['src'] });
});

test('loadRole: accepts Codex-specific model levels', async () => {
  const transport = makeTransport({
    'roles/developer-codex': {
      id: 'developer-codex',
      name: 'developer-codex',
      system_prompt: 'Implement with Codex.',
      model_level: 'codex-standard',
      effort: 'high',
      runner: 'codex',
      allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
      scope_rules: '',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('developer-codex', transport);

  assert.equal(role.modelLevel, 'codex-standard');
  assert.equal(role.runner, 'codex');
});

test('loadModelProfile: accepts Codex-specific model profiles', async () => {
  const transport = makeTransport({
    'model_profiles/codex-standard': {
      id: 'codex-standard',
      level: 'codex-standard',
      provider: 'openai',
      model_id: 'gpt-5.5',
      params: '{}',
      cost_per_input: 2,
      cost_per_output: 8,
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const profile = await loadModelProfile('codex-standard', transport);

  assert.equal(profile.level, 'codex-standard');
  assert.equal(profile.provider, 'openai');
  assert.equal(profile.modelId, 'gpt-5.5');
});

test('loadRole: empty scope_rules deserializes to {}', async () => {
  const transport = makeTransport({
    'roles/developer': {
      id: 'developer',
      name: 'developer',
      system_prompt: 'Implement.',
      model_level: 'standard',
      effort: 'medium',
      runner: 'claude-code',
      allowed_tools: [],
      scope_rules: '',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('developer', transport);

  assert.deepEqual(role.scopeRules, {});
});

test('loadRole: throws ROW_NOT_FOUND when row is missing', async () => {
  const transport = makeTransport({});

  await assert.rejects(
    () => loadRole('unknown-role', transport),
    (err: unknown) => {
      const e = err as { statusCode?: number };
      return e.statusCode === 404;
    },
  );
});

test('loadModelProfile: deserializes a model_profiles row', async () => {
  const transport = makeTransport({
    'model_profiles/standard': {
      id: 'standard',
      level: 'standard',
      provider: 'anthropic',
      model_id: 'claude-sonnet-4-6',
      params: '{"temperature":0.2}',
      cost_per_input: 3,
      cost_per_output: 15,
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const profile = await loadModelProfile('standard', transport);

  assert.equal(profile.level, 'standard');
  assert.equal(profile.provider, 'anthropic');
  assert.equal(profile.modelId, 'claude-sonnet-4-6');
  assert.deepEqual(profile.params, { temperature: 0.2 });
  assert.equal(profile.costPerInput, 3);
  assert.equal(profile.costPerOutput, 15);
});

test('loadModelProfile: empty params deserializes to {}', async () => {
  const transport = makeTransport({
    'model_profiles/cheap': {
      id: 'cheap',
      level: 'cheap',
      provider: 'anthropic',
      model_id: 'claude-haiku-4-5-20251001',
      params: '',
      cost_per_input: 0.8,
      cost_per_output: 4,
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const profile = await loadModelProfile('cheap', transport);

  assert.deepEqual(profile.params, {});
});

test('loadModelProfile: throws ROW_NOT_FOUND when row is missing', async () => {
  const transport = makeTransport({});

  await assert.rejects(
    () => loadModelProfile('unknown-level', transport),
    (err: unknown) => {
      const e = err as { statusCode?: number };
      return e.statusCode === 404;
    },
  );
});

test('loadRole: throws VALIDATION_FAILURE for invalid model_level', async () => {
  const transport = makeTransport({
    'roles/bad-role': {
      id: 'bad-role',
      name: 'bad-role',
      system_prompt: 'Bad.',
      model_level: 'ultra-expensive',
      effort: 'low',
      runner: 'claude-code',
      allowed_tools: [],
      scope_rules: '',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  await assert.rejects(
    () => loadRole('bad-role', transport),
    (err: unknown) =>
      err instanceof ControlPlaneError &&
      err.code === 'VALIDATION_FAILURE' &&
      err.message.includes('ultra-expensive'),
  );
});

// ─── loadPipelinePolicy (0008 #5) ────────────────────────────────────────────

test('loadPipelinePolicy: parses the rule JSON for limits + budget', async () => {
  const transport = makeTransport({
    'routing_policy/pipeline': {
      id: 'pipeline',
      rule: '{"max_review_iterations":5,"max_attempts":4,"budget_usd":2.5,"budget_tokens":1000}',
    },
  });
  const policy = await loadPipelinePolicy(transport);
  assert.equal(policy.maxReviewIterations, 5);
  assert.equal(policy.maxAttempts, 4);
  assert.equal(policy.budgetUsd, 2.5);
  assert.equal(policy.budgetTokens, 1000);
});

test('loadPipelinePolicy: absent row → safe defaults (routing_policy starts empty)', async () => {
  const policy = await loadPipelinePolicy(makeTransport({}));
  assert.equal(policy.maxReviewIterations, 3);
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.budgetUsd, 0);
  assert.equal(policy.budgetTokens, 0);
});

test('loadPipelinePolicy: MALFORMED rule JSON rethrows (does NOT silently disable the budget)', async () => {
  const transport = makeTransport({
    'routing_policy/pipeline': { id: 'pipeline', rule: '{not valid json' },
  });
  await assert.rejects(() => loadPipelinePolicy(transport), /JSON|Unexpected|token/i);
});

test('loadPipelinePolicy: transport error (non-404) rethrows', async () => {
  const transport: ControlPlaneTransport = {
    mode: 'head' as const,
    async assertReady() {},
    async listRows() { return { edges: [] }; },
    async getRow() { throw new ControlPlaneError('HTTP_ERROR', 'boom'); },
    async createRow() { throw new Error('ro'); },
    async updateRow() { throw new Error('ro'); },
    async patchRow() { throw new Error('ro'); },
  };
  await assert.rejects(() => loadPipelinePolicy(transport), (e: unknown) => e instanceof ControlPlaneError && e.code === 'HTTP_ERROR');
});
