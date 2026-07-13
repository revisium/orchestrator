import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRole, loadPipelinePolicy } from './definitions.js';
import { ControlPlaneError } from './errors.js';
import type { ControlPlaneTransport } from './transport.js';

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
      rights: 'read-only',
      allowed_tools: ['read', 'write'],
      scope_rules: '{"allow":["src"]}',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  });

  const role = await loadRole('architect', transport);

  assert.equal(role.name, 'architect');
  assert.equal(role.systemPrompt, 'Plan the work.');
  assert.equal(role.rights, 'read-only');
  assert.deepEqual(role.allowedTools, ['read', 'write']);
  assert.deepEqual(role.scopeRules, { allow: ['src'] });
});

test('loadRole: empty scope_rules deserializes to {}', async () => {
  const transport = makeTransport({
    'roles/developer': {
      id: 'developer',
      name: 'developer',
      system_prompt: 'Implement.',
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
    async getRow() { throw new ControlPlaneError('TRANSPORT_ERROR', 'boom'); },
    async createRow() { throw new Error('ro'); },
    async updateRow() { throw new Error('ro'); },
    async patchRow() { throw new Error('ro'); },
  };
  await assert.rejects(
    () => loadPipelinePolicy(transport),
    (e: unknown) => e instanceof ControlPlaneError && e.code === 'TRANSPORT_ERROR',
  );
});
