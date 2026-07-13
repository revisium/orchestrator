import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneError } from '../control-plane/errors.js';
import { createInMemoryRuntimeDataAccess } from '../testing/runtime-data-access.js';
import { RunService } from './run.service.js';

test('RunService constructor wires injected runtime data access', () => {
  const { access } = createInMemoryRuntimeDataAccess();
  assert.doesNotThrow(() => new RunService(access));
});

test('RunService uses injected runtime data access', () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new RunService(access);
  assert.ok(svc instanceof RunService);
});

test('RunService.createRun delegates to createRunWorkflow (writes task_runs+tasks+events)', async () => {
  const runtime = createInMemoryRuntimeDataAccess();
  const svc = new RunService(runtime.access);
  const result = await svc.createRun({
    title: 'Test run', repo: 'my-repo', now: new Date('2026-06-07T10:00:00.000Z'), idSuffix: 'aabbccdd',
  });
  const createdTables = runtime.calls
    .flatMap((call) => call.method === 'createRow' ? [call.table] : []);
  assert.ok(result.runId.startsWith('run_'));
  assert.ok(result.taskId.startsWith('task_'));
  assert.ok(result.eventId.startsWith('event_'));
  assert.deepEqual(createdTables.sort(), ['events', 'task_runs', 'tasks'].sort());
});

test('RunService.showRun returns null for unknown run', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new RunService(access);
  const result = await svc.showRun('run-nope');
  assert.equal(result, null);
});

test('RunService.listRuns delegates to listRuns and returns RunSummary[]', async () => {
  const { access } = createInMemoryRuntimeDataAccess({
    task_runs: {
      'run-1': { id: 'run-1', title: 'Run 1', status: 'ready', priority: 0, repos: [] },
      'run-2': { id: 'run-2', title: 'Run 2', status: 'done', priority: 1, repos: [] },
    },
  });
  const svc = new RunService(access);
  const summaries = await svc.listRuns();
  assert.equal(summaries.length, 2);
  assert.ok(summaries.some((s) => s.runId === 'run-1'));
});

test('RunService.cancelRun delegates to cancelRun and returns CancelRunResult', async () => {
  const runtime = createInMemoryRuntimeDataAccess({
    task_runs: {
      'run-1': { id: 'run-1', title: 'Run', status: 'ready', repos: [] },
    },
  });
  const svc = new RunService(runtime.access);
  const result = await svc.cancelRun('run-1');
  const patchedRows = runtime.calls
    .filter((call) => call.method === 'patchRow')
    .map((call) => call.rowId);
  assert.ok(result !== null);
  assert.equal(result.runId, 'run-1');
  assert.equal(result.previousStatus, 'ready');
  assert.equal(result.status, 'cancelled');
  assert.ok(patchedRows.includes('run-1'));
});

test('RunService.getRun returns null when run not found', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new RunService(access);
  const result = await svc.getRun('run-nope');
  assert.equal(result, null);
});

test('loadPipelineContext synthesizes a step from the selected role without model aliases', async () => {
  const runId = 'run-lpc-1';
  const taskId = 'task-lpc-1';
  const { access } = createInMemoryRuntimeDataAccess({
    task_runs: {
      [runId]: { id: runId, title: 'Test run', status: 'ready', priority: 0, repos: [] },
    },
    tasks: {
      [taskId]: { id: taskId, run_id: runId, title: 'My task', status: 'ready', repos: [] },
    },
  });

  const svc = new RunService(access);
  const { step, da } = await svc.loadPipelineContext(runId, 'architect', 'architect', { phase: 'plan' });

  assert.equal(step.role, 'architect');
  assert.equal(step.runId, runId);
  assert.equal(step.taskId, taskId);
  assert.ok(step.id.startsWith('pstep_'), `step.id must start with pstep_: ${step.id}`);
  assert.ok(step.id.length <= 64, `step.id must be ≤64 chars: ${step.id.length}`);
  assert.ok(da !== null && da !== undefined, 'da must be returned');
});

test('C4: loadPipelineContext throws ROW_NOT_FOUND when run does not exist (B6 guard)', async () => {
  const { access } = createInMemoryRuntimeDataAccess();
  const svc = new RunService(access);
  await assert.rejects(
    () => svc.loadPipelineContext('run-missing', 'architect', 'architect', {}),
    (err: unknown) => {
      assert.ok(err instanceof ControlPlaneError);
      assert.equal(err.code, 'ROW_NOT_FOUND');
      assert.ok(err.message.includes('run not found'), `expected 'run not found' in: ${err.message}`);
      return true;
    },
  );
});
