import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContext } from './build-context.js';
import type { ControlPlaneDataAccess, ListRowsOptions } from '../control-plane/data-access.js';
import type { Step } from '../control-plane/steps.js';
import type { Role } from '../control-plane/definitions.js';
import { fakeRow, makeRole, BASE_STEP } from './test-fixtures.js';

function makeDA(opts: {
  task?: Record<string, unknown>;
  attempts?: Array<Record<string, unknown>>;
  onListRows?: (table: string, listOpts: ListRowsOptions | undefined) => void;
}): ControlPlaneDataAccess {
  return {
    async assertReady() {},
    async listRows(table, listOpts) {
      opts.onListRows?.(table, listOpts);
      if (table === 'attempts') {
        let rows = (opts.attempts ?? []).map((a, i) => fakeRow(`attempt-${i}`, a));
        // Honor a simple data.path/equals predicate to simulate server-side filtering.
        const whereData = (listOpts?.where as { data?: { path?: string; equals?: unknown } } | undefined)?.data;
        if (whereData?.path && whereData.equals !== undefined) {
          rows = rows.filter((r) => String(r.data[whereData.path!]) === String(whereData.equals));
        }
        return rows;
      }
      return [];
    },
    async getRow(table, rowId) {
      if (table === 'tasks' && opts.task) return fakeRow(rowId, opts.task);
      return null;
    },
    async createRow(t, rowId, data) { return fakeRow(rowId, data); },
    async updateRow(t, rowId, data) { return fakeRow(rowId, data); },
    async patchRow(t, rowId) {
      const row = { rowId, data: {} };
      return row;
    },
  };
}

const ROLE: Role = makeRole('architect', { scopeRules: { allow: ['src'] } });

const STEP: Step = { ...BASE_STEP, input: { title: 'Add feature X' } };

test('buildContext: includes role name and system prompt', async () => {
  const da = makeDA({});
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('## Role: architect'), 'should include role name');
  assert.ok(ctx.includes('You are the architect.'), 'should include system prompt');
});

test('buildContext: includes scope rules', async () => {
  const da = makeDA({});
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('"allow"'), 'should include scope rules JSON');
});

test('buildContext: includes task title when task exists', async () => {
  const da = makeDA({ task: { title: 'My Feature', scope: 'backend', repo_ref: 'my-repo' } });
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('My Feature'), 'should include task title');
  assert.ok(ctx.includes('backend'), 'should include task scope');
  assert.ok(ctx.includes('my-repo'), 'should include task repo');
});

test('buildContext: uses fallback when task is missing', async () => {
  const da = makeDA({});
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('(unknown task)'), 'should fall back to unknown task');
});

test('buildContext: includes prior failed attempt lessons', async () => {
  const da = makeDA({
    attempts: [
      { step_id: 'step-1', status: 'failed', lesson: 'the build was broken' },
      { step_id: 'step-1', status: 'failed', lesson: '' },
      { step_id: 'step-2', status: 'failed', lesson: 'other step lesson' },
    ],
  });
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('the build was broken'), 'should include lesson from same step');
  assert.ok(!ctx.includes('other step lesson'), 'should NOT include lesson from other step');
  assert.ok(!ctx.includes('## Prior failed attempt lessons:\n- \n'), 'should omit empty lessons');
});

test('buildContext: no prior lessons section when all attempts succeeded', async () => {
  const da = makeDA({
    attempts: [{ step_id: 'step-1', status: 'succeeded', lesson: '' }],
  });
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(!ctx.includes('Prior failed attempt lessons'), 'should not include lessons section');
});

test('buildContext: includes current step input', async () => {
  const da = makeDA({});
  const ctx = await buildContext(da, STEP, ROLE);
  assert.ok(ctx.includes('"Add feature X"'), 'should include step input JSON');
});

test('buildContext: includes run description, public params, and bounded planPath content', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'revo-context-'));
  try {
    writeFileSync(join(repo, 'plan.md'), '# Plan\nDo the scoped work.\nSECRET_TOKEN=abc123\n');
    const da = makeDA({ task: { title: 'My Feature', scope: 'backend', repo_ref: repo } });
    const ctx = await buildContext(da, STEP, ROLE, {
      description: 'Run-level description',
      params: { planPath: 'plan.md', ticket: 'RV-1' },
    });
    assert.ok(ctx.includes('## Run description:\nRun-level description'));
    assert.ok(ctx.includes('"ticket": "RV-1"'));
    assert.ok(ctx.includes('## Required context: params.planPath'));
    assert.ok(ctx.includes('# Plan\nDo the scoped work.'));
    assert.ok(ctx.includes('SECRET_TOKEN=[REDACTED]'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildContext: materializes absolute params.planPath from a sibling workspace plan folder', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'revo-workspace-'));
  try {
    const repo = join(workspace, 'agent-orchestrator-admin');
    const plans = join(workspace, 'revo-plans', 'admin');
    mkdirSync(repo, { recursive: true });
    mkdirSync(plans, { recursive: true });
    const planPath = join(plans, '002-runs.md');
    writeFileSync(planPath, '# Runs\nRead-only run views.\n');

    const da = makeDA({ task: { title: 'Admin runs', scope: 'frontend', repo_ref: repo } });
    const ctx = await buildContext(da, STEP, ROLE, {
      description: '',
      params: { planPath },
    });

    assert.ok(ctx.includes('## Required context: params.planPath'));
    assert.ok(ctx.includes(planPath));
    assert.ok(ctx.includes('# Runs\nRead-only run views.'));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('buildContext: params.planPath outside the task workspace is rejected', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'revo-workspace-'));
  const outside = mkdtempSync(join(tmpdir(), 'revo-outside-'));
  try {
    const repo = join(workspace, 'agent-orchestrator-admin');
    mkdirSync(repo, { recursive: true });
    const planPath = join(outside, 'plan.md');
    writeFileSync(planPath, '# Outside\n');
    const da = makeDA({ task: { title: 'Admin runs', scope: 'frontend', repo_ref: repo } });

    await assert.rejects(
      () => buildContext(da, STEP, ROLE, { description: '', params: { planPath } }),
      /revo\.ContextMissing: params\.planPath is outside task workspace/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('buildContext: inaccessible params.planPath fails before agent execution', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'revo-context-'));
  try {
    const da = makeDA({ task: { title: 'My Feature', scope: 'backend', repo_ref: repo } });
    await assert.rejects(
      () => buildContext(da, STEP, ROLE, { description: '', params: { planPath: 'missing.md' } }),
      /revo\.ContextMissing: params\.planPath is not readable: missing\.md/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('buildContext: null input renders as null', async () => {
  const da = makeDA({});
  const nullStep: Step = { ...STEP, input: null };
  const ctx = await buildContext(da, nullStep, ROLE);
  assert.ok(ctx.includes('null'), 'should render null input');
});

test('buildContext: passes step_id where predicate to listRows for attempts', async () => {
  const attemptsListOpts: ListRowsOptions[] = [];
  const da = makeDA({
    onListRows(table, listOpts) {
      if (table === 'attempts') attemptsListOpts.push(listOpts ?? {});
    },
  });
  await buildContext(da, STEP, ROLE);
  assert.equal(attemptsListOpts.length, 1, 'listRows(attempts) called exactly once');
  const w = attemptsListOpts[0]?.where as { data?: { path?: string; equals?: unknown } } | undefined;
  assert.equal(w?.data?.path, 'step_id', 'where.data.path should be step_id');
  assert.equal(w?.data?.equals, STEP.id, 'where.data.equals should be the step id');
});
