import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { CreateRunCommand } from '../impl/create-run.command.js';
import { CreateRunHandler } from './runs-command.handlers.js';

test('runs command handlers delegate through TaskControlPlaneApiService', async () => {
  const api = {
    async createRun(input: unknown) {
      assert.deepEqual(input, { title: 'Build', repo: '.', start: false });
      return { runId: 'run_1', taskId: 'task_1', eventId: 'event_1', status: 'ready', started: false };
    },
  } as unknown as TaskControlPlaneApiService;

  const result = await new CreateRunHandler(api).execute(new CreateRunCommand({ title: 'Build', repo: '.', start: false }));
  assert.equal(result.runId, 'run_1');
});
