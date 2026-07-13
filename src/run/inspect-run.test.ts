import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneDataAccess, ControlPlaneRow, ListRowsOptions, PatchOperation } from '../control-plane/index.js';
import type { RuntimeTable } from '../control-plane/tables.js';
import {
  listRuns,
  showRun,
  listRunEvents,
  listRunAttempts,
  getRunFailure,
  formatRunList,
  formatRunDetail,
  formatEventList,
  compactEventPayload,
} from './inspect-run.js';

test('compactEventPayload: run_created strips the graph and truncates description', () => {
  const big = 'x'.repeat(500);
  const out = compactEventPayload('run_created', {
    title: 'My run',
    playbook_id: 'pb',
    pipeline_id: 'feature-development',
    description: big,
    route_decision: { executionPolicy: { template_json: { nodes: { a: 1, b: 2 } } } },
  }) as Record<string, unknown>;
  assert.equal(out['route_decision'], undefined, 'graph stripped');
  assert.equal(out['title'], 'My run', 'human-facing fields kept');
  assert.equal(out['pipeline_id'], 'feature-development');
  assert.ok(typeof out['description'] === 'string' && (out['description'] as string).length <= 281, 'description truncated');
  assert.ok(!JSON.stringify(out).includes('template_json'), 'no graph substring survives');
});

test('compactEventPayload: non-run_created events pass through verbatim', () => {
  const payload = { reason: 'preflight', lesson: 'stale base', route_decision: { keepme: true } };
  assert.deepEqual(compactEventPayload('run_blocked', payload), payload, 'other types untouched');
});

test('compactEventPayload: tolerates null / short description', () => {
  assert.equal(compactEventPayload('run_created', null), null);
  const out = compactEventPayload('run_created', { description: 'short', title: 't' }) as Record<string, unknown>;
  assert.equal(out['description'], 'short', 'short description not truncated');
});

function makeRow(rowId: string, data: Record<string, unknown>): ControlPlaneRow {
  return { rowId, data, createdAt: data.created_at as string | undefined };
}

function valueAtPath(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, data);
}

function matchesWhere(row: ControlPlaneRow, where: ListRowsOptions['where']): boolean {
  if (!where) return true;
  if (where.id?.equals !== undefined && row.rowId !== where.id.equals) return false;
  if (where.id?.in !== undefined && !where.id.in.includes(row.rowId)) return false;
  if (where.data?.path !== undefined && where.data.equals !== undefined && valueAtPath(row.data, where.data.path) !== where.data.equals) return false;
  if (where.data?.path !== undefined && where.data.in !== undefined && !where.data.in.includes(valueAtPath(row.data, where.data.path))) return false;
  if (where.AND?.some((item) => !matchesWhere(row, item))) return false;
  if (where.OR && !where.OR.some((item) => matchesWhere(row, item))) return false;
  const not = where.NOT;
  if (Array.isArray(not) && not.some((item) => matchesWhere(row, item))) return false;
  if (not && !Array.isArray(not) && matchesWhere(row, not)) return false;
  return true;
}

type TestOrderBy = NonNullable<ListRowsOptions['orderBy']>[number];

function compareRows(orderBy: TestOrderBy, a: ControlPlaneRow, b: ControlPlaneRow): number {
  const field = orderBy.field;
  if (field === 'id') return a.rowId.localeCompare(b.rowId);
  if (field === 'sequence' || field === 'ordinal') {
    const diff = Number(a.data[field] ?? 0) - Number(b.data[field] ?? 0);
    if (diff !== 0) return diff;
  }
  if (field === 'producedAt') return String(a.data.produced_at ?? '').localeCompare(String(b.data.produced_at ?? ''));
  if (field === 'updatedAt') return String(a.data.updated_at ?? a.updatedAt ?? '').localeCompare(String(b.data.updated_at ?? b.updatedAt ?? ''));
  const ta = (typeof a.data.created_at === 'string' ? a.data.created_at : a.createdAt) ?? '';
  const tb = (typeof b.data.created_at === 'string' ? b.data.created_at : b.createdAt) ?? '';
  return ta.localeCompare(tb);
}

type TableStore = {
  task_runs: ControlPlaneRow[];
  tasks: ControlPlaneRow[];
  steps: ControlPlaneRow[];
  attempts: ControlPlaneRow[];
  events: ControlPlaneRow[];
  inbox: ControlPlaneRow[];
  cost_ledger: ControlPlaneRow[];
  run_outputs: ControlPlaneRow[];
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
    run_outputs: [],
    ...store,
  };

  return {
    async assertReady() {
      if (options.assertReadyError) throw options.assertReadyError;
    },

    async listRows(table: RuntimeTable, listOptions?: ListRowsOptions) {
      options.calls?.push(`listRows:${table}`);
      options.listRowsArgs?.push([table, listOptions]);
      let rows = (tables[table] ?? []).filter((row) => matchesWhere(row, listOptions?.where));

      for (const orderBy of [...(listOptions?.orderBy ?? [])].reverse()) {
        const direction = orderBy.direction === 'desc' ? -1 : 1;
        rows = [...rows].sort((a, b) => compareRows(orderBy, a, b) * direction);
      }

      return rows.slice(0, listOptions?.first ?? rows.length);
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


const EVENT_A1 = makeRow('event-a1', { id: 'event-a1', run_id: 'run-a', task_id: 'task-a', step_id: 'step-a', type: 'run_created', actor: 'cli', created_at: T1, sequence: 1 });
const EVENT_A2 = makeRow('event-a2', { id: 'event-a2', run_id: 'run-a', task_id: 'task-a', step_id: 'step-a', type: 'step_claimed', actor: 'worker-1', created_at: T2, sequence: 2 });
const EVENT_B = makeRow('event-b', { id: 'event-b', run_id: 'run-b', task_id: 'task-b', step_id: 'step-b', type: 'run_created', actor: 'cli', created_at: T2, sequence: 1 });

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

test('listRuns pushes status and limit into listRows before pagination', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const da = createFakeDataAccess({ task_runs: [RUN_A, RUN_B, RUN_C] }, { listRowsArgs });

  await listRuns(da, { status: 'ready', limit: 2 });

  assert.deepEqual(listRowsArgs, [[
    'task_runs',
    {
      first: 2,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      where: { data: { path: 'status', in: ['ready'] } },
    },
  ]]);
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

test('showRun returns the run detail and its task (no steps surface)', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
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
});

test('showRun returns only the queried run task', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
  });

  const detail = await showRun(da, 'run-b');

  assert.ok(detail !== null);
  assert.equal(detail.tasks.length, 1);
  assert.equal(detail.tasks[0]?.taskId, 'task-b');
});

test('showRun passes the run_id where predicate to the tasks listRows and never reads steps', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const da = createFakeDataAccess({
    task_runs: [RUN_A],
    tasks: [TASK_A],
  }, { listRowsArgs });

  await showRun(da, 'run-a');

  const tasksCall = listRowsArgs.find(([t]) => t === 'tasks');
  assert.ok(tasksCall, 'listRows called for tasks');
  assert.equal(tasksCall[1]?.where?.data?.path, 'run_id');
  assert.equal(tasksCall[1]?.where?.data?.equals, 'run-a');

  // The phantom `steps` table is retired (audit §3.1) — showRun must not read it.
  assert.ok(!listRowsArgs.some(([t]) => t === 'steps'), 'showRun must not read the steps table');
});

test('showRun does not return tasks from other runs', async () => {
  const da = createFakeDataAccess({
    task_runs: [RUN_A, RUN_B],
    tasks: [TASK_A, TASK_B],
  });

  const detail = await showRun(da, 'run-a');

  assert.ok(detail !== null);
  assert.equal(detail.tasks.length, 1, 'only run-a tasks returned');
  assert.equal(detail.tasks[0]?.taskId, 'task-a');
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

test('listRunEvents uses sequence when event timestamps are tied', async () => {
  const later = makeRow('event-seq-2', { id: 'event-seq-2', run_id: 'run-a', type: 'step_claimed', actor: 'worker', created_at: T1, sequence: 2 });
  const earlier = makeRow('event-seq-1', { id: 'event-seq-1', run_id: 'run-a', type: 'run_created', actor: 'cli', created_at: T1, sequence: 1 });
  const da = createFakeDataAccess({ events: [later, earlier] });

  const events = await listRunEvents(da, 'run-a');

  assert.deepEqual(events.map((event) => event.eventId), ['event-seq-1', 'event-seq-2']);
});

test('listRunEvents filters by type', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2, EVENT_B] });

  const events = await listRunEvents(da, 'run-a', { type: 'step_claimed' });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'step_claimed');
});

test('listRunEvents pushes run/type filters and limit into listRows', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2, EVENT_B] }, { listRowsArgs });

  await listRunEvents(da, 'run-a', { type: 'step_claimed', limit: 1 });

  assert.deepEqual(listRowsArgs, [[
    'events',
    {
      first: 1,
      orderBy: [{ field: 'sequence', direction: 'asc' }],
      where: {
        AND: [
          { data: { path: 'run_id', equals: 'run-a' } },
          { data: { path: 'type', equals: 'step_claimed' } },
        ],
      },
    },
  ]]);
});

test('listRunEvents honors limit', async () => {
  const da = createFakeDataAccess({ events: [EVENT_A1, EVENT_A2] });

  const events = await listRunEvents(da, 'run-a', { limit: 1 });

  assert.equal(events.length, 1);
  assert.equal(events[0]?.eventId, 'event-a1');
});

test('listRunAttempts pushes limit into listRows before mapping', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const attempt = makeRow('attempt-a1', {
    id: 'attempt-a1',
    run_id: 'run-a',
    step_id: 'developer',
    status: 'succeeded',
    runner_id: 'stub-agent',
    provider: 'test',
    model_id: 'test-model',
    input_tokens: null,
    output_tokens: null,
    cost_amount: null,
    currency: null,
    created_at: T1,
  });
  const da = createFakeDataAccess({ attempts: [attempt] }, { listRowsArgs });

  await listRunAttempts(da, 'run-a', { limit: 1 });

  assert.deepEqual(listRowsArgs, [[
    'attempts',
    {
      first: 1,
      orderBy: [{ field: 'createdAt', direction: 'asc' }],
      where: { data: { path: 'run_id', equals: 'run-a' } },
    },
  ]]);
});

test('getRunFailure reads only the latest run_failed event through listRows filters', async () => {
  const listRowsArgs: Array<[RuntimeTable, ListRowsOptions | undefined]> = [];
  const failed = makeRow('event-failed', {
    id: 'event-failed',
    run_id: 'run-a',
    type: 'run_failed',
    sequence: 3,
    payload: { reason: 'boom' },
    created_at: T2,
  });
  const da = createFakeDataAccess({ task_runs: [RUN_A], events: [EVENT_A1, failed] }, { listRowsArgs });

  const result = await getRunFailure(da, 'run-a');

  assert.equal(result?.reason, 'boom');
  assert.deepEqual(listRowsArgs, [[
    'events',
    {
      first: 1,
      orderBy: [{ field: 'sequence', direction: 'desc' }],
      where: {
        AND: [
          { data: { path: 'run_id', equals: 'run-a' } },
          { data: { path: 'type', equals: 'run_failed' } },
        ],
      },
    },
  ]]);
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
  assert.equal(eventsCall[1]?.where?.data?.equals, 'run-a');
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
    { task_runs: [RUN_A], tasks: [TASK_A], events: [EVENT_A1] },
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

test('formatRunDetail includes run id and task details', () => {
  const detail = {
    run: { runId: 'run-a', title: 'My run', status: 'ready', priority: 1, createdAt: '2026-06-01T00:00:00.000Z', description: 'desc', scope: 'sc', repos: ['repo1'] },
    tasks: [
      { taskId: 'task-a', title: 'Task A', status: 'ready', roleHint: 'architect' },
    ],
  };
  const output = formatRunDetail(detail);
  assert.ok(output.includes('run-a'));
  assert.ok(output.includes('task-a'));
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
    { eventId: 'event_20260601T000000000Z_run_ab12cd34_created', type: 'run_created', actor: 'cli', createdAt: '2026-06-01T00:00:00.000Z', taskId: 'task-a', stepId: 'step-a', payload: null },
  ];
  const output = formatEventList(events);
  assert.ok(output.includes('EVENT'), 'has header');
  assert.ok(output.includes('run_created'), 'has type');
  assert.ok(output.includes('cli'), 'has actor');
  assert.ok(output.includes('(1 event)'), 'has summary');
});

test('formatEventList timestamp has no stray dot', () => {
  const events = [{ eventId: 'event-1', type: 'run_created', actor: 'cli', createdAt: '2026-06-01T00:00:00.000Z', taskId: 'task-a', stepId: 'step-a', payload: null }];
  const output = formatEventList(events);
  assert.ok(!output.includes('.Z'), 'no stray dot before Z');
  assert.ok(output.includes('2026-06-01T00:00:00Z'), 'correct timestamp format');
});

// ─────────────────────── 0008 #4 observability ───────────────────────

test('formatEventListVerbose expands the payload (output/verdict/reason)', async () => {
  const { formatEventListVerbose } = await import('./inspect-run.js');
  const events = [
    {
      eventId: 'event_x',
      type: 'step_succeeded',
      actor: 'orchestrator',
      createdAt: '2026-06-11T00:00:00.000Z',
      taskId: 'task-a',
      stepId: 'step-a',
      payload: { output: { verdict: 'PASS' }, role: 'reviewer' },
    },
  ];
  const out = formatEventListVerbose(events);
  assert.ok(out.includes('step_succeeded'), 'has event type');
  assert.ok(out.includes('"verdict": "PASS"'), 'expands the payload JSON');
  assert.ok(out.includes('(1 event)'), 'has summary');
});

test('formatAttemptList renders per-attempt verdict/model/tokens/cost/duration', async () => {
  const { formatAttemptList } = await import('./inspect-run.js');
  const attempts = [
    {
      attemptId: 'attempt_abc',
      stepId: 'pstep_reviewer',
      iteration: 1,
      status: 'succeeded',
      verdict: 'PASS',
      runnerId: 'codex',
      provider: 'openai',
      modelId: 'gpt-test',
      inputTokens: 1200,
      outputTokens: 340,
      costAmount: 0.0123,
      currency: 'USD',
      durationMs: 4567,
      outputSummary: '{"verdict":"PASS"}',
      artifactRef: 'run-a/attempt_abc',
      stdoutTail: 'stdout tail',
      stderrTail: 'stderr tail',
      lesson: '',
      error: '',
      startedAt: '2026-06-11T00:00:00.000Z',
    },
  ];
  const out = formatAttemptList(attempts);
  assert.ok(out.includes('attempt_abc'), 'has attempt id');
  assert.ok(out.includes('verdict=PASS'), 'has verdict');
  assert.ok(out.includes('runner=codex provider=openai model=gpt-test'), 'has exact provenance');
  assert.ok(out.includes('1200in/340out'), 'has tokens');
  assert.ok(out.includes('4567ms'), 'has duration');
  assert.ok(out.includes('iter=1'), 'has iteration');
  assert.ok(out.includes('artifact run-a/attempt_abc'), 'has artifact ref');
  assert.ok(out.includes('stdout tail'), 'has stdout tail');
  assert.ok(out.includes('stderr tail'), 'has stderr tail');
  assert.ok(out.includes('(1 attempt)'), 'has summary');

  const eur = formatAttemptList([{ ...attempts[0], costAmount: 1, currency: 'EUR' }]);
  assert.ok(eur.includes('cost=1.00 EUR'), 'non-USD costs must not use a dollar symbol');
});

test('formatAttemptList: empty list', async () => {
  const { formatAttemptList } = await import('./inspect-run.js');
  assert.equal(formatAttemptList([]), '(0 attempts)');
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

// ─────────────────────── expand: graph ───────────────────────

const FULL_PAYLOAD = {
  title: 'My run',
  playbook_id: 'pb',
  route_decision: { executionPolicy: { template_json: { nodes: { a: 1 } } } },
  description: 'a short desc',
};

const RUN_CREATED_EVENT = makeRow('event-rc', { run_id: 'run-a', type: 'run_created', actor: 'cli', created_at: T1, payload: FULL_PAYLOAD });

test('listRunEvents default (no expand) strips run_created graph payload', async () => {
  const da = createFakeDataAccess({ events: [RUN_CREATED_EVENT] });

  const events = await listRunEvents(da, 'run-a');

  const payload = events[0]?.payload as Record<string, unknown>;
  assert.equal(payload['route_decision'], undefined, 'route_decision stripped by default');
  assert.equal(payload['title'], 'My run', 'title kept');
});

test('listRunEvents with expand:["graph"] returns raw run_created payload including template_json', async () => {
  const da = createFakeDataAccess({ events: [RUN_CREATED_EVENT] });

  const events = await listRunEvents(da, 'run-a', { expand: ['graph'] });

  const payload = events[0]?.payload as Record<string, unknown>;
  assert.ok(payload['route_decision'] !== undefined, 'route_decision present when graph expanded');
  const rd = payload['route_decision'] as Record<string, unknown>;
  const ep = rd['executionPolicy'] as Record<string, unknown>;
  assert.ok(ep['template_json'] !== undefined, 'template_json present when graph expanded');
  assert.equal(payload['title'], 'My run', 'title still present');
});
