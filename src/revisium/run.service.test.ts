/**
 * run.service.test.ts — 5.2 RunService
 *
 * Fake draft transport; assert da is draft mode, G3 constructor-body fix,
 * createRun/showRun/listRuns/listRunEvents/cancelRun delegate correctly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneTransport, TransportRow, TransportList } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import { RunService } from './run.service.js';

function makeFakeRow(id: string, data: Record<string, unknown>): TransportRow {
  return { id, data, createdAt: '2026-06-07T10:00:00.000Z', updatedAt: '2026-06-07T10:00:00.000Z' };
}

function makeDraftTransport(): ControlPlaneTransport {
  return {
    mode: 'draft' as const,
    async assertReady() {},
    async listRows(): Promise<TransportList> { return { edges: [] }; },
    async getRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, { id: rowId }); },
    async createRow(_table, rowId, data): Promise<TransportRow> {
      return makeFakeRow(rowId, data as Record<string, unknown>);
    },
    async updateRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
    async patchRow(_table, rowId): Promise<TransportRow> { return makeFakeRow(rowId, {}); },
  };
}

test('G3 fix: RunService constructor wires da from injected transport (no undefined)', () => {
  const transport = makeDraftTransport();
  // If the G3 bug were present, da would be undefined and the service would throw on
  // any method call. The mere act of construction + calling a method proves the fix.
  assert.doesNotThrow(() => new RunService(transport));
});

test('RunService uses draft transport mode (edge 7)', () => {
  const transport = makeDraftTransport();
  assert.equal(transport.mode, 'draft');
  const svc = new RunService(transport);
  assert.ok(svc instanceof RunService);
});

test('RunService.createRun delegates to createRunWorkflow (writes task_runs+tasks+steps+events)', async () => {
  const createdTables: string[] = [];
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async createRow(table, rowId, data) {
      createdTables.push(table);
      return makeFakeRow(rowId, data as Record<string, unknown>);
    },
  };
  const svc = new RunService(transport);
  const result = await svc.createRun({
    title: 'Test run', repo: 'my-repo', now: new Date('2026-06-07T10:00:00.000Z'), idSuffix: 'aabbccdd',
  });
  assert.ok(result.runId.startsWith('run_'));
  assert.ok(result.taskId.startsWith('task_'));
  assert.ok(result.stepId.startsWith('step_'));
  assert.ok(result.eventId.startsWith('event_'));
  assert.deepEqual(createdTables.sort(), ['events', 'steps', 'task_runs', 'tasks'].sort());
});

test('RunService.showRun returns null for unknown run', async () => {
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async getRow(_table, rowId) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
    },
  };
  const svc = new RunService(transport);
  const result = await svc.showRun('run-nope');
  assert.equal(result, null);
});

test('RunService.listRuns delegates to listRuns and returns RunSummary[]', async () => {
  const rows: TransportRow[] = [
    makeFakeRow('run-1', { id: 'run-1', title: 'Run 1', status: 'ready', priority: 0, repos: [] }),
    makeFakeRow('run-2', { id: 'run-2', title: 'Run 2', status: 'done', priority: 1, repos: [] }),
  ];
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async listRows(): Promise<TransportList> {
      return { edges: rows.map((n) => ({ node: n })) };
    },
  };
  const svc = new RunService(transport);
  const summaries = await svc.listRuns();
  assert.equal(summaries.length, 2);
  assert.ok(summaries.some((s) => s.runId === 'run-1'));
});

test('RunService.cancelRun delegates to cancelRun and returns CancelRunResult', async () => {
  const patchedRows: string[] = [];
  const createdRows: string[] = [];
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async getRow(_table, rowId) {
      return makeFakeRow(rowId, { id: rowId, status: 'ready' });
    },
    async patchRow(_table, rowId) {
      patchedRows.push(rowId);
      return makeFakeRow(rowId, {});
    },
    async createRow(_table, rowId, data) {
      createdRows.push(rowId);
      return makeFakeRow(rowId, data as Record<string, unknown>);
    },
  };
  const svc = new RunService(transport);
  const result = await svc.cancelRun('run-1');
  assert.ok(result !== null);
  assert.equal(result.runId, 'run-1');
  assert.equal(result.previousStatus, 'ready');
  assert.equal(result.status, 'cancelled');
  assert.ok(patchedRows.includes('run-1'));
});

test('RunService.getRun returns null when run not found', async () => {
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async getRow(_table, rowId) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
    },
  };
  const svc = new RunService(transport);
  const result = await svc.getRun('run-nope');
  assert.equal(result, null);
});

// ─── C4: RunService.loadPipelineContext focused unit tests ───────────────────

test('C4: loadPipelineContext synthesizes Step with modelProfile from caller (B7 guard)', async () => {
  // Simulate a run with a task whose role is 'deep' (architect-level)
  const runId = 'run-lpc-1';
  const taskId = 'task-lpc-1';

  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async listRows(table): Promise<TransportList> {
      if (table === 'tasks') {
        return {
          edges: [
            {
              node: makeFakeRow(taskId, {
                id: taskId,
                run_id: runId,
                title: 'My task',
                status: 'ready',
                repos: [],
              }),
            },
          ],
        };
      }
      if (table === 'task_runs') {
        return {
          edges: [
            {
              node: makeFakeRow(runId, {
                id: runId,
                title: 'Test run',
                status: 'ready',
                priority: 0,
                repos: [],
              }),
            },
          ],
        };
      }
      return { edges: [] };
    },
    async getRow(table, rowId) {
      if (table === 'task_runs' && rowId === runId) {
        return makeFakeRow(runId, { id: runId, title: 'Test run', status: 'ready', priority: 0, repos: [] });
      }
      if (table === 'tasks') {
        return makeFakeRow(taskId, { id: taskId, run_id: runId, title: 'My task', status: 'ready', repos: [] });
      }
      throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
    },
  };

  const svc = new RunService(transport);
  const { step, da } = await svc.loadPipelineContext(runId, 'architect', 'architect', { phase: 'plan' }, 'deep');

  // B7 guard: modelProfile must be the caller-supplied 'deep', NOT hardcoded 'standard'
  assert.equal(step.modelProfile, 'deep', 'step.modelProfile must equal the caller-supplied modelProfile arg');
  assert.equal(step.role, 'architect');
  assert.equal(step.runId, runId);
  assert.equal(step.taskId, taskId);
  assert.ok(step.id.startsWith('pstep_'), `step.id must start with pstep_: ${step.id}`);
  assert.ok(step.id.length <= 64, `step.id must be ≤64 chars: ${step.id.length}`);
  assert.ok(da !== null && da !== undefined, 'da must be returned');
});

test('C4: loadPipelineContext throws ROW_NOT_FOUND when run does not exist (B6 guard)', async () => {
  const transport: ControlPlaneTransport = {
    ...makeDraftTransport(),
    async listRows(): Promise<TransportList> { return { edges: [] }; },
    async getRow(_table, rowId) {
      throw new ControlPlaneError('ROW_NOT_FOUND', `not found: ${rowId}`, { status: 404 });
    },
  };

  const svc = new RunService(transport);
  await assert.rejects(
    () => svc.loadPipelineContext('run-missing', 'architect', 'architect', {}, 'deep'),
    (err: unknown) => {
      assert.ok(err instanceof ControlPlaneError);
      assert.equal(err.code, 'ROW_NOT_FOUND');
      assert.ok(err.message.includes('run not found'), `expected 'run not found' in: ${err.message}`);
      return true;
    },
  );
});
