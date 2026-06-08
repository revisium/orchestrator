/**
 * run.service.load-run-task-context.test.ts — B6: loadRunTaskContext.
 *
 * Verifies that loadRunTaskContext returns the correct { taskId, title, base, repoRef }
 * from showRun.tasks[0] and run.repos[0], defaults base to 'master', and throws
 * clear errors on missing run/task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RunService } from './run.service.js';
import type { ControlPlaneTransport, TransportRow } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeFakeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-06-08T00:00:00.000Z', updatedAt: '2026-06-08T00:00:00.000Z' };
}

function makeTransport(opts: {
  runId: string;
  taskId: string;
  title?: string;
  repos?: string[];
  hasRun?: boolean;
  hasTasks?: boolean;
}): ControlPlaneTransport {
  const {
    runId,
    taskId,
    title = 'Test task',
    repos = ['/path/to/repo'],
    hasRun = true,
    hasTasks = true,
  } = opts;

  return {
    mode: 'draft' as const,
    async assertReady() {},
    async getRow(table, rowId): Promise<TransportRow> {
      if (table === 'task_runs' && rowId === runId && hasRun) {
        return makeFakeRow(runId, { id: runId, title: 'Run title', status: 'ready', priority: 0, repos });
      }
      throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
    },
    async listRows(table): Promise<{ edges: Array<{ node: TransportRow }> }> {
      if (table === 'tasks' && hasTasks) {
        return {
          edges: [
            {
              node: makeFakeRow(taskId, {
                id: taskId,
                run_id: runId,
                title,
                status: 'ready',
                role_hint: 'architect',
              }),
            },
          ],
        };
      }
      if (table === 'steps') return { edges: [] };
      return { edges: [] };
    },
    async createRow(table, rowId, data): Promise<TransportRow> { return makeFakeRow(rowId, data as Record<string, unknown>); },
    async updateRow(table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
    async patchRow(table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
  };
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('loadRunTaskContext: returns { taskId, title, base:"master", repoRef } from tasks[0] + repos[0]', async () => {
  const transport = makeTransport({
    runId: 'run-ctx-1',
    taskId: 'task-ctx-1',
    title: 'My feature task',
    repos: ['/home/user/target-repo'],
  });
  const svc = new RunService(transport);

  const ctx = await svc.loadRunTaskContext('run-ctx-1');

  assert.equal(ctx.taskId, 'task-ctx-1');
  assert.equal(ctx.title, 'My feature task');
  assert.equal(ctx.base, 'master', 'base must always default to master');
  assert.equal(ctx.repoRef, '/home/user/target-repo');
});

test('loadRunTaskContext: base is always "master" (no base in run input)', async () => {
  const transport = makeTransport({
    runId: 'run-ctx-2',
    taskId: 'task-ctx-2',
    repos: [],
  });
  const svc = new RunService(transport);
  const ctx = await svc.loadRunTaskContext('run-ctx-2');
  assert.equal(ctx.base, 'master');
});

test('loadRunTaskContext: empty repos array → repoRef is empty string', async () => {
  const transport = makeTransport({
    runId: 'run-ctx-3',
    taskId: 'task-ctx-3',
    repos: [],
  });
  const svc = new RunService(transport);
  const ctx = await svc.loadRunTaskContext('run-ctx-3');
  assert.equal(ctx.repoRef, '');
});

test('loadRunTaskContext: showRun returns null → throws ROW_NOT_FOUND', async () => {
  const transport = makeTransport({
    runId: 'run-ctx-missing',
    taskId: 'task-ctx-missing',
    hasRun: false,
  });
  const svc = new RunService(transport);

  await assert.rejects(
    () => svc.loadRunTaskContext('run-ctx-missing'),
    (err: unknown) => {
      assert.ok(err instanceof ControlPlaneError);
      assert.equal(err.code, 'ROW_NOT_FOUND');
      assert.ok(err.message.includes('run-ctx-missing'), `must name the runId: ${err.message}`);
      return true;
    },
  );
});

test('loadRunTaskContext: run has no tasks → throws ROW_NOT_FOUND', async () => {
  const transport = makeTransport({
    runId: 'run-ctx-notasks',
    taskId: 'task-xyz',
    hasTasks: false,
  });
  const svc = new RunService(transport);

  await assert.rejects(
    () => svc.loadRunTaskContext('run-ctx-notasks'),
    (err: unknown) => {
      assert.ok(err instanceof ControlPlaneError);
      assert.equal(err.code, 'ROW_NOT_FOUND');
      assert.ok(err.message.includes('no task'), `must say "no task": ${err.message}`);
      return true;
    },
  );
});
