import { guardSmokeIsolation } from '../src/smoke/isolation.js';
import { createSmokeApi } from './smoke-support.js';

guardSmokeIsolation({ scriptName: 'smoke:inspect-run' });

const smoke = await createSmokeApi();

try {
  const title = `Smoke inspect run ${Date.now()}`;
  const created = await smoke.api.createRun({
    title,
    repo: '.',
    scope: 'smoke',
    playbookId: 'revisium-default',
    pipelineId: 'local-change',
  });
  const runId = created.runId;
  console.log(`created runId=${runId}`);

  const listData = await smoke.api.listRuns({ limit: 100 });
  if (!listData.some((r) => r.runId === runId)) {
    throw new Error(`run ${runId} not found in list output`);
  }
  console.log(`run list: ${listData.length} run(s), run appears OK`);

  const showData = await smoke.api.getRun({ runId, includeEvents: true });
  if (showData.run.runId !== runId)
    throw new Error(`show: runId mismatch: ${showData.run.runId}`);
  if (showData.tasks.length !== 1)
    throw new Error(`show: expected 1 task, got ${showData.tasks.length}`);
  console.log(`run show: run=${runId} tasks=${showData.tasks.length} OK`);

  const eventsData = await smoke.api.getRunEvents({ runId });
  const createdEvent = eventsData.find((e) => e.type === 'run_created');
  if (!createdEvent) throw new Error('events: no run_created event found');
  console.log(`run events: ${eventsData.length} event(s), run_created OK`);

  const runRow = await smoke.draft.getRow('task_runs', runId);
  const taskId = showData.tasks[0]?.taskId;
  if (!taskId) throw new Error('Missing taskId from show output');
  const taskRow = await smoke.draft.getRow('tasks', taskId);
  if (!runRow) throw new Error(`Missing task_runs row ${runId} after inspect`);
  if (!taskRow) throw new Error(`Missing tasks row ${taskId} after inspect`);
  if (runRow.data.status !== 'ready')
    throw new Error(`Run status mutated: ${String(runRow.data.status)}`);
  if (taskRow.data.status !== 'ready')
    throw new Error(`Task status mutated: ${String(taskRow.data.status)}`);
  console.log(
    `no mutation confirmed: run=${String(runRow.data.status)} task=${String(taskRow.data.status)}`,
  );

  await smoke.api.getRun({ runId: 'nonexistent-run-id' }).then(
    () => {
      throw new Error('getRun nonexistent should throw');
    },
    (error: unknown) => {
      if (!String(error).includes('run not found')) throw error;
    },
  );
  console.log('unknown run id throws: OK');

  console.log('smoke:inspect-run PASSED');
} finally {
  await smoke.close();
}
