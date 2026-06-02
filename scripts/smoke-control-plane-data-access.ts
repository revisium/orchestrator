import { createControlPlaneDataAccess } from '../src/control-plane/index.js';

const cp = createControlPlaneDataAccess();
const suffix = Date.now();
const runId = `smoke-run-${suffix}`;
const taskId = `smoke-task-${suffix}`;
const stepId = `smoke-step-${suffix}`;
const eventId = `smoke-event-${suffix}`;
const inboxId = `smoke-inbox-${suffix}`;
const now = new Date().toISOString();

await cp.assertReady();

await cp.createRow('task_runs', runId, {
  project_id: 'agent-orchestrator',
  title: 'Control-plane data-access smoke',
  description: 'Draft-only smoke run',
  status: 'running',
  repos: ['agent-orchestrator'],
  scope: 'plan-0002',
  priority: 0,
  created_by: 'smoke',
  created_at: now,
  updated_at: now,
});

await cp.createRow('tasks', taskId, {
  run_id: runId,
  repo_ref: 'agent-orchestrator',
  role_hint: 'developer',
  title: 'Smoke task',
  status: 'running',
  depends_on: [],
  scope: 'plan-0002',
  priority: 0,
  created_at: now,
  updated_at: now,
});

await cp.createRow('steps', stepId, {
  task_id: taskId,
  run_id: runId,
  role: 'developer',
  kind: 'smoke',
  status: 'running',
  input: { repo: 'agent-orchestrator', plan: '0002' },
  output: null,
  model_profile: 'standard',
  run_after: '',
  attempt_count: 0,
  max_attempts: 1,
  priority: 0,
  lease_owner: '',
  lease_expires_at: '',
  dead_reason: '',
  created_at: now,
  updated_at: now,
});

const patchedStep = await cp.patchRow('steps', stepId, [
  { op: 'replace', path: 'output', value: { ok: true, patched: true } },
]);
if (JSON.stringify(patchedStep.data.output) !== JSON.stringify({ ok: true, patched: true })) {
  throw new Error(`Patched step output did not round-trip for ${stepId}`);
}

await cp.createRow('events', eventId, {
  run_id: runId,
  task_id: taskId,
  step_id: stepId,
  type: 'smoke',
  payload: { runId, stepId },
  actor: 'smoke',
  created_at: now,
});

await cp.createRow('inbox', inboxId, {
  kind: 'question',
  run_id: runId,
  task_id: taskId,
  step_id: stepId,
  project_id: 'agent-orchestrator',
  title: 'Smoke inbox item',
  context: { runId, stepId },
  options: ['ok'],
  status: 'pending',
  answer: null,
  resolved_by: '',
  created_at: now,
  resolved_at: '',
});

const runs = await cp.listRows('task_runs', { first: 100 });
if (!runs.some((row) => row.rowId === runId)) {
  throw new Error(`Smoke run ${runId} was not listed from draft task_runs`);
}

const headCp = createControlPlaneDataAccess({ revision: 'head' });
const headStep = await headCp.getRow('steps', stepId);
if (headStep !== null) {
  throw new Error(`Smoke step ${stepId} unexpectedly visible from head`);
}

console.log(`smokeRunId=${runId}`);
console.log(`smokeTaskId=${taskId}`);
console.log(`smokeStepId=${stepId}`);
console.log('draftContainsSmokeRows=true');
console.log('headContainsSmokeStep=false');
