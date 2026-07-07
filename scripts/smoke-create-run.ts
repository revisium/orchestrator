import { guardSmokeIsolation } from '../src/smoke/isolation.js';
import { createSmokeApi } from './smoke-support.js';

guardSmokeIsolation({ scriptName: 'smoke:create-run' });

const smoke = await createSmokeApi();

try {
  const title = `Smoke create run ${Date.now()}`;
  const created = await smoke.api.createRun({
    title,
    repo: '.',
    description: 'Embedded storage smoke',
    scope: 'smoke',
    priority: 1,
    playbookId: 'revisium-default',
    pipelineId: 'local-change',
  });

  const runId = created.runId;
  const taskId = created.taskId;
  const eventId = created.eventId;

  const run = await smoke.draft.getRow('task_runs', runId);
  const task = await smoke.draft.getRow('tasks', taskId);
  const event = await smoke.draft.getRow('events', eventId);

  if (!run) throw new Error(`Missing draft task_runs row ${runId}`);
  if (!task) throw new Error(`Missing draft tasks row ${taskId}`);
  if (!event) throw new Error(`Missing draft events row ${eventId}`);

  if (run.data.status !== 'ready') throw new Error(`Unexpected run status: ${String(run.data.status)}`);
  if (task.data.status !== 'ready') throw new Error(`Unexpected task status: ${String(task.data.status)}`);
  if (task.data.run_id !== runId) throw new Error(`Task ${taskId} does not point at run ${runId}`);
  if (event.data.type !== 'run_created') throw new Error(`Unexpected event type: ${String(event.data.type)}`);
  if (typeof event.data.payload !== 'object' || event.data.payload === null || Array.isArray(event.data.payload)) {
    throw new Error('Event payload did not deserialize to an object');
  }

  const headRun = await smoke.head.getRow('task_runs', runId);
  if (headRun !== null) {
    throw new Error(`Smoke run ${runId} unexpectedly visible from head`);
  }

  console.log(`smokeRunId=${runId}`);
  console.log(`smokeTaskId=${taskId}`);
  console.log(`smokeEventId=${eventId}`);
  console.log('draftContainsSmokeRows=true');
  console.log('headContainsSmokeRun=false');
} finally {
  await smoke.close();
}
