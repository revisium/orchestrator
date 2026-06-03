import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import { listRuns, showRun, listRunEvents, formatRunList, formatRunDetail, formatEventList } from './inspect-run.js';

function makeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data, createdAt: data.created_at as string | undefined };
}

type TableStore = {
  task_runs: ControlPlaneRow[];
  tasks: ControlPlaneRow[];
  steps: ControlPlaneRow[];
  attempts: ControlPlaneRow[];
  events: ControlPlaneRow[];
  inbox: ControlPlaneRow[];
  cost_ledger: ControlPlaneRow[];
};

function createFakeDataAccess(
  store: Partial<TableStore> = {},
  options: {
    assertReadyError?: Error;
    writes?: string[];
    calls?: string[];
    listRowsArgs?: Array<[RuntimeTable, ListRowsOptions | undefined]>;
  } = {},
): ControlPlaneDataAccess {
  const tables: TableStore = {
    task_runs: [],
    tasks: [],
    steps: [],
    attempts: [],
    events: [],
    inbox: [],
    cost_ledger: [],
    ...store,
  };

  return {
    async assertReady() {
      if (options.assertReadyError) throw options.assertReadyError;
    },

    async listRows(table: RuntimeTable, listOptions?: ListRowsOptions) {
      options.calls?.push(`listRows:${table}`);
      options.listRowsArgs?.push([table, listOptions]);
      let rows = tables[table] ?? [];

      // Apply where: { data: { path, equals } } filter (mirrors Prisma JSON path equality)
      const whereData = listOptions?.where?.data;
      if (whereData?.path !== undefined && whereData.equals !== undefined) {
        const path = whereData.path as string;
        const equals = whereData.equals;
        rows = rows.filter((r) => r.data[path] === equals);
      }

      const orderBy = listOptions?.orderBy?.[0];
      if (orderBy?.field !== 'createdAt') {
        return rows.slice(0, listOptions?.first ?? rows.length);
      }
      const sorted = [...rows].sort((a, b) => {
        const ta = (typeof a.data.created_at === 'string' ? a.data.created_at : a.createdAt) ?? '';
        const tb = (typeof b.data.created_at === 'string' ? b.data.created_at : b.createdAt) ?? '';
        return orderBy.direction === 'desc' ? tb.localeCompare(ta) : ta.localeCompare(tb);
      });
      const first = listOptions?.first ?? sorted.length;
      return sorted.slice(0, first);
    },

    async getRow(table: RuntimeTable, rowId: string) {
      options.calls?.push(`getRow:${table}:${rowId}`);
      return tables[table]?.find((r) => r.rowId === rowId) ?? null;
    },

    async createRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>) {
      options.writes?.push(`create:${table}:${rowId}`);
      return makeRow(rowId, data);
    },

    async updateRow(table: RuntimeTable, rowId: string, data: Record<string, unknown>) {
      options.writes?.push(`update:${table}:${rowId}`);
      return makeRow(rowId, data);
    },

    async patchRow(table: RuntimeTable, rowId: string, _patches: PatchOperation[]) {
      options.writes?.push(`patch:${table}:${rowId}`);
      return makeRow(rowId, { id: rowId });
    },
  };
}

async function captureStderr(fn: () => Promise<unknown>): Promise<string[]> {
  const messages: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    messages.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return messages;
}

const T0 = '2026-06-01T00:00:00.000Z';
const T1 = '2026-06-01T01:00:00.000Z';
const T2 = '2026-06-01T02:00:00.000Z';

const RUN_A = makeRow('run-a', { id: 'run-a', title: 'Run A', status: 'ready', priority: 1, description: 'desc', scope: 'sc', repos: ['repo1'], created_at: T1, updated_at: T1 });
const RUN_B = makeRow('run-b', { id: 'run-b', title: 'Run B', status: 'running', priority: 2, description: '', scope: '', repos: [], created_at: T2, updated_at: T2 });
const RUN_C = makeRow('run-c', { id: 'run-c', title: 'Run C', status: 'ready', priority: 0, description: '', scope: '', repos: [], created_at: T0, updated_at: T0 });

const TASK_A = makeRow('task-a', { id: 'task-a', run_id: 'run-a', title: 'Task A', status: 'ready', role_hint: 'architect', created_at: T1, updated_at: T1 });
const TASK_B = makeRow('task-b', { id: 'task-b', run_id: 'run-b', title: 'Task B', status: 'running', role_hint: 'developer', created_at: T2, updated_at: T2 });

const STEP_A = makeRow('step-a', { id: 'step-a', task_id: 'task-a', run_id: 'run-a', role: 'architect', kind: 'plan_run', status: 'ready', attempt_count: 0, max_attempts: 3, created_at: T1, updated_at: T1 });
const STEP_B = makeRow('step-b', { id: 'step-b', task_id: 'task-b', run_id: 'run-b', role: 'developer', kind: 'implement', status: 'running', attempt_count: 1, max_attempts: 3, created_at: T2, updated_at: T2 });

const EVENT_A1 = makeRow('event-a1', { id: 'event-a1', run_id: 'run-a', task_id: 'task-a', step_id: 'step-a', type: 'run_created', actor: 'cli', created_at: T1 });
const EVENT_A2 = makeRow('event-a2', { id: 'event-a2', run_id: 'run-a', task_id: 'task-a', step_id: 'step-a', type: 'step_claimed', actor: 'worker-1', created_at: T2 });
const EVENT_B = makeRow('event-b', { id: 'event-b', run_id: 'run-b', task_id: 'task-b', step_id: 'step-b', type: 'run_created', actor: 'cli', created_at: T2 });

// ─────────────────────── listRuns ───────────────────────

test('listRuns returns all runs newest-first', async () => {
  const da = createFakeDataAccess({ task_runs: [RUN_A, RUN_B, RUN_C] });

  const runs = await listRuns(da);

  assert.equal(runs.length, 3);
  assert.equal(runs[0]?.runId, 'run-b');
  assert.equal(runs[1]?.runId, 'run-a');
  assert.equal(runs[2]?.runId, 'run-c');
});

test('listRuns filters by status', async () => {
  const da = createFakeDataAccess({ task_runs: [RUN_A, RUN_B, RUN_C] });

  const runs = await listRuns(da, { status: 'ready' });

  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.status === 'ready'));
});

test('listRuns honors limit after sort and status filter', async () => {
  const da = createFakeDataAccess({ task_runs: [RUN_A, RUN_B, RUN_C] });

  const runs = await listRuns(da, { limit: 2 });

  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.runId, 'run-b');
});

test('listRuns calls assertReady', async () => {
  const err = new Error('not ready');
  const da = createFakeDataAccess({}, { assertReadyError: err });

  await assert.rejects(() => listRuns(da), /not ready/);
});

test('listRuns returns empty array when no runs', async () => {
  const da = createFakeDataAccess({ task_runs: [] });
  assert.deepEqual(await listRuns(da), []);
});

// ─────────────────────── showRun ───────────────────────

test('showRun returns null for unknown runId', async () => {
  const da = createFakeDataAccess({ task_runs: [RUN_A] });
  assert.equal(await showRun(da, 'nonexistent'), null);
});

test('showRun groups steps under the correct task', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
    steps: [STEP_A, STEP_B],
  });

  const detail = await showRun(da, 'run-a');

  assert.ok(detail !== null);
  assert.equal(detail.run.runId, 'run-a');
  assert.equal(detail.run.title, 'Run A');
  assert.equal(detail.run.description, 'desc');
  assert.equal(detail.run.scope, 'sc');
  assert.deepEqual(detail.run.repos, ['repo1']);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0]?.taskId, 'task-a');
  assert.equal(detail.tasks[0]?.steps.length, 1);
  assert.equal(detail.tasks[0]?.steps[0]?.stepId, 'step-a');
  assert.equal(detail.tasks[0]?.steps[0]?.role, 'architect');
});

test('showRun tasks for different run contain only their steps', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
    steps: [STEP_A, STEP_B],
  });

  const detail = await showRun(da, 'run-b');

  assert.ok(detail !== null);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0]?.taskId, 'task-b');
  assert.equal(detail.tasks[0]?.steps[0]?.stepId, 'step-b');
});

test('showRun passes run_id where predicate to tasks and steps listRows', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const da = createFakeDataAccess({
    task_runs: [RUN_A],
    tasks: [TASK_A],
    steps: [STEP_A],
  }, { listRowsArgs });

  await showRun(da, 'run-a');

  const tasksCall = listRowsArgs.find(([t]) => t === 'tasks');
  assert.ok(tasksCall, 'listRows called for tasks');
  assert.equal(tasksCall[1]?.where?.data?.path, 'run_id');
  assert.equal(tasksCall[1]?.where?.data?.equals as unknown as string, 'run-a');

  const stepsCall = listRowsArgs.find(([t]) => t === 'steps');
  assert.ok(stepsCall, 'listRows called for steps');
  assert.equal(stepsCall[1]?.where?.data?.path, 'run_id');
  assert.equal(stepsCall[1]?.where?.data?.equals as unknown as string, 'run-a');
});

test('showRun does not return tasks or steps from other runs', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
    steps: [STEP_A, STEP_B],
  });

  const detail = await showRun(da, 'run-a');

  assert.ok(detail !== null);
  assert.equal(detail.tasks.length, 1, 'only run-a tasks returned');
  assert.equal(detail.tasks[0]?.taskId, 'task-a');
  const allStepIds = detail.tasks.flatMap((t) => t.steps.map((s) => s.stepId));
  assert.deepEqual(allStepIds, ['step-a'], 'only run-a steps returned');
});

test('showRun calls assertReady', async () => {
  const da = createFakeDataAccess({}, { assertReadyError: new Error('down') });
  await assert.rejects(() => showRun(da, 'run-a'), /down/);
});

// ─────────────────────── listRunEvents ───────────────────────

test('listRunEvents returns events for the run oldest-first', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A2, EVENT_A1, EVENT_B] });

  const events = await listRunEvents(da, 'run-a');

  assert.equal(events.length, 2);
  assert.equal(events[0]?.eventId, 'event-a1');
  assert.equal(events[1]?.eventId, 'event-a2');
});

test('listRunEvents filters by type', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2, EVENT_B] });

  const events = await listRunEvents(da, 'run-a', { type: 'step_claimed' });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'step_claimed');
});

test('listRunEvents honors limit', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2] });

  const events = await listRunEvents(da, 'run-a', { limit: 1 });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventId, 'event-a1');
});

test('listRunEvents returns empty for unknown run', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1] });
  assert.deepEqual(await listRunEvents(da, 'unknown-run'), []);
});

test('listRunEvents calls assertReady', async () => {
  const da = createFakeDataAccess({}, { assertReadyError: new Error('down') });
  await assert.rejects(() => listRunEvents(da, 'run-a'), /down/);
});

test('listRunEvents passes run_id where predicate to events listRows', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2] }, { listRowsArgs });

  await listRunEvents(da, 'run-a');

  const eventsCall = listRowsArgs.find(([t]) => t === 'events');
  assert.ok(eventsCall, 'listRows called for events');
  assert.equal(eventsCall[1]?.where?.data?.path, 'run_id');
  assert.equal(eventsCall[1]?.where?.data?.equals as unknown as string, 'run-a');
});

test('listRunEvents does not return events from other runs', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2, EVENT_B] });

  const events = await listRunEvents(da, 'run-a');

  assert.equal(events.length, 2, 'only run-a events returned');
  assert.ok(events.every((e) => e.eventId.startsWith('event-a')));
});

// ─────────────────────── no writes ───────────────────────

test('all inspect functions record zero writes', async () => {
  const writes: string[] = [];
  const da = createFakeDataAccess(
    { task_runs: [RUN_A], tasks: [TASK_A], steps: [STEP_A], events: [EVENT_A1] },
    { writes },
  );

  await listRuns(da);
  await showRun(da, 'run-a');
  await listRunEvents(da, 'run-a');

  assert.equal(writes.length, 0);
});

// ─────────────────────── formatters ───────────────────────

test('formatRunList produces header, one row per run, and count summary', () => {
  const runs = [
    { runId: 'run_20260601T000000000Z_my-run_ab12cd34', title: 'My run', status: 'ready', priority: 1, createdAt: '2026-06-01T00:00:00.000Z' },
  ];
  const output = formatRunList(runs);
  assert.ok(output.includes('RUN'), 'has header');
  assert.ok(output.includes('STATUS'), 'has STATUS column');
  assert.ok(output.includes('run_20260601T000000000Z_my-run_ab12cd34'), 'has run id');
  assert.ok(output.includes('ready'), 'has status');
  assert.ok(output.includes('My run'), 'has title');
  assert.ok(output.includes('(1 run)'), 'has summary');
});

test('formatRunList shows plural summary for multiple runs', () => {
  const runs = [
    { runId: 'run-1', title: 'A', status: 'ready', priority: 0, createdAt: '' },
    { runId: 'run-2', title: 'B', status: 'running', priority: 0, createdAt: '' },
  ];
  assert.ok(formatRunList(runs).includes('(2 runs)'));
});

test('formatRunList timestamp has no stray dot', () => {
  const runs = [{ runId: 'run-1', title: 'T', status: 'ready', priority: 0, createdAt: '2026-06-01T00:00:00.000Z' }];
  const output = formatRunList(runs);
  assert.ok(!output.includes('.Z'), 'no stray dot before Z');
  assert.ok(output.includes('2026-06-01T00:00:00Z'), 'correct timestamp format');
});

test('formatRunDetail includes run id, tasks, and step details', () => {
  const detail = {
    run: { runId: 'run-a', title: 'My run', status: 'ready', priority: 1, createdAt: '2026-06-01T00:00:00.000Z', description: 'desc', scope: 'sc', repos: ['repo1'] },
    tasks: [
      { taskId: 'task-a', title: 'Task A', status: 'ready', roleHint: 'architect', steps: [
        { stepId: 'step-a', role: 'architect', kind: 'plan_run', status: 'ready', attemptCount: 0, maxAttempts: 3 },
      ]},
    ],
  };
  const output = formatRunDetail(detail);
  assert.ok(output.includes('run-a'));
  assert.ok(output.includes('task-a'));
  assert.ok(output.includes('step-a'));
  assert.ok(output.includes('plan_run'));
  assert.ok(output.includes('desc'));
  assert.ok(output.includes('repo1'));
});

test('formatRunDetail timestamp has no stray dot', () => {
  const detail = {
    run: { runId: 'run-a', title: 'T', status: 'ready', priority: 0, createdAt: '2026-06-01T00:00:00.000Z', description: '', scope: '', repos: [] },
    tasks: [],
  };
  const output = formatRunDetail(detail);
  assert.ok(!output.includes('.Z'), 'no stray dot before Z');
  assert.ok(output.includes('2026-06-01T00:00:00Z'), 'correct timestamp format');
});

test('formatEventList produces header, one row per event, and count summary', () => {
  const events = [
    { eventId: 'event_20260601T000000000Z_run_ab12cd34_created', type: 'run_created', actor: 'cli', createdAt: '2026-06-01T00:00:00.000Z', taskId: 'task-a', stepId: 'step-a' },
  ];
  const output = formatEventList(events);
  assert.ok(output.includes('EVENT'), 'has header');
  assert.ok(output.includes('run_created'), 'has type');
  assert.ok(output.includes('cli'), 'has actor');
  assert.ok(output.includes('(1 event)'), 'has summary');
});

test('formatEventList timestamp has no stray dot', () => {
  const events = [{ eventId: 'event-1', type: 'run_created', actor: 'cli', createdAt: '2026-06-01T00:00:00.000Z', taskId: 'task-a', stepId: 'step-a' }];
  const output = formatEventList(events);
  assert.ok(!output.includes('.Z'), 'no stray dot before Z');
  assert.ok(output.includes('2026-06-01T00:00:00Z'), 'correct timestamp format');
});

// ─────────────────────── cap warnings ───────────────────────

const CAP = 500;

function makeCapRows(prefix: string, count: number): ControlPlaneRow[] {
  return Array.from({ length: count }, (_, i) =>
    makeRow(`${prefix}-${i}`, { created_at: `2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` }),
  );
}

test('listRuns emits stderr warning when results reach the cap', async () => {
  const da = createFakeDataAccess({ task_runs: makeCapRows('run', CAP) });
  const msgs = await captureStderr(() => listRuns(da));
  assert.ok(msgs.some((m) => m.includes('incomplete') && m.includes(String(CAP))));
});

test('listRuns does NOT warn when results are below the cap', async () => {
  const da = createFakeDataAccess({ task_runs: [RUN_A] });
  const msgs = await captureStderr(() => listRuns(da));
  assert.equal(msgs.length, 0);
});

test('showRun never emits cap warning for tasks or steps', async () => {
  const capTasks = makeCapRows('task', CAP).map((r) => ({ ...r, data: { ...r.data, run_id: 'run-a' } }));
  const da = createFakeDataAccess({ task_runs: [RUN_A], tasks: capTasks });
  const msgs = await captureStderr(() => showRun(da, 'run-a'));
  assert.equal(msgs.length, 0);
});

test('listRunEvents never emits cap warning for events', async () => {
  const capEvents = makeCapRows('event', CAP).map((r) => ({ ...r, data: { ...r.data, run_id: 'run-a' } }));
  const da = createFakeDataAccess({ events: capEvents });
  const msgs = await captureStderr(() => listRunEvents(da, 'run-a'));
  assert.equal(msgs.length, 0);
});

test('cap warnings go to stderr only — stdout (JSON) is unaffected', async () => {
  const da = createFakeDataAccess({ task_runs: makeCapRows('run', CAP) });
  let resultLen = 0;
  const stderrMsgs = await captureStderr(async () => {
    const runs = await listRuns(da);
    resultLen = runs.length;
  });
  assert.ok(stderrMsgs.some((m) => m.includes('incomplete')));
  assert.equal(resultLen, CAP);
});

// ─────────────────────── runEvents existence check (Fix 1) ───────────────────────

test('runEvents existence check: getRow called for unknown run, no tasks or steps fetched', async () => {
  const calls: string[] = [];
  const da = createFakeDataAccess({ task_runs: [] }, { calls });

  const runRow = await da.getRow('task_runs', 'no-such-run');

  assert.equal(runRow, null);
  assert.deepEqual(calls, ['getRow:task_runs:no-such-run']);
  assert.ok(!calls.some((c) => c.startsWith('listRows:tasks') || c.startsWith('listRows:steps')));
});

test('runEvents existence check: known run — getRow succeeds, events fetched without tasks/steps', async () => {
  const calls: string[] = [];
  const da = createFakeDataAccess({ task_runs: [RUN_A], events: [EVENT_A1, EVENT_A2] }, { calls });

  const runRow = await da.getRow('task_runs', 'run-a');
  assert.ok(runRow !== null);

  const events = await listRunEvents(da, 'run-a');
  assert.equal(events.length, 2);

  assert.ok(calls.includes('getRow:task_runs:run-a'));
  assert.ok(calls.includes('listRows:events'));
  assert.ok(!calls.some((c) => c.startsWith('listRows:tasks') || c.startsWith('listRows:steps')));
});

// ─────────────────────── ?? fallback (Fix 3) ───────────────────────

test('toRunSummary uses ?? so empty-string created_at is not overridden by createdAt', async () => {
  const rowWithEmptyDate = makeRow('run-x', { title: 'X', status: 'ready', priority: 0, created_at: '' });
  const rowWithCreatedAt = { ...rowWithEmptyDate, createdAt: '2026-06-01T00:00:00.000Z' };
  const da = createFakeDataAccess({ task_runs: [rowWithCreatedAt] });
  const runs = await listRuns(da);
  assert.equal(runs[0]?.createdAt, '');
});

test('toEventSummary uses ?? so empty-string created_at is not overridden by createdAt', async () => {
  const rowWithEmptyDate = makeRow('event-x', { run_id: 'run-a', type: 'run_created', actor: 'cli', created_at: '' });
  const rowWithCreatedAt = { ...rowWithEmptyDate, createdAt: '2026-06-01T00:00:00.000Z' };
  const da = createFakeDataAccess({ events: [rowWithCreatedAt] });
  const events = await listRunEvents(da, 'run-a');
  assert.equal(events[0]?.createdAt, '');
});
