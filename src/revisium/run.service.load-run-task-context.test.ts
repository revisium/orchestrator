import test from 'node:test';
import assert from 'node:assert/strict';
import { RunService } from './run.service.js';
import { createInMemoryRuntimeDataAccess, type RuntimeDataAccessSeed } from '../testing/runtime-data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';

function makeSeed(opts: {
  runId: string;
  taskId: string;
  title?: string;
  repos?: string[];
  hasRun?: boolean;
  hasTasks?: boolean;
}): RuntimeDataAccessSeed {
  const {
    runId,
    taskId,
    title = 'Test task',
    repos = ['/path/to/repo'],
    hasRun = true,
    hasTasks = true,
  } = opts;

  const seed: RuntimeDataAccessSeed = {};
  if (hasRun) {
    seed.task_runs = {
      [runId]: { id: runId, title: 'Run title', status: 'ready', priority: 0, repos },
    };
  }
  if (hasTasks) {
    seed.tasks = {
      [taskId]: {
        id: taskId,
        run_id: runId,
        title,
        status: 'ready',
        role_hint: 'architect',
      },
    };
  }
  return seed;
}

function makeService(seed: RuntimeDataAccessSeed): RunService {
  return new RunService(createInMemoryRuntimeDataAccess(seed).access);
}

test('loadRunTaskContext: returns { taskId, title, base:"master", repoRef } from tasks[0] + repos[0]', async () => {
  const svc = makeService(makeSeed({
    runId: 'run-ctx-1',
    taskId: 'task-ctx-1',
    title: 'My feature task',
    repos: ['/home/user/target-repo'],
  }));

  const ctx = await svc.loadRunTaskContext('run-ctx-1');

  assert.equal(ctx.taskId, 'task-ctx-1');
  assert.equal(ctx.title, 'My feature task');
  assert.equal(ctx.base, 'master', 'base must always default to master');
  assert.equal(ctx.repoRef, '/home/user/target-repo');
});

test('loadRunTaskContext: base is always "master" (no base in run input)', async () => {
  const svc = makeService(makeSeed({
    runId: 'run-ctx-2',
    taskId: 'task-ctx-2',
    repos: [],
  }));
  const ctx = await svc.loadRunTaskContext('run-ctx-2');
  assert.equal(ctx.base, 'master');
});

test('loadRunTaskContext: empty repos array → repoRef is empty string', async () => {
  const svc = makeService(makeSeed({
    runId: 'run-ctx-3',
    taskId: 'task-ctx-3',
    repos: [],
  }));
  const ctx = await svc.loadRunTaskContext('run-ctx-3');
  assert.equal(ctx.repoRef, '');
});

test('loadRunTaskContext: showRun returns null → throws ROW_NOT_FOUND', async () => {
  const svc = makeService(makeSeed({
    runId: 'run-ctx-missing',
    taskId: 'task-ctx-missing',
    hasRun: false,
  }));

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
  const svc = makeService(makeSeed({
    runId: 'run-ctx-notasks',
    taskId: 'task-xyz',
    hasTasks: false,
  }));

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
