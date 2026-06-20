import type { RowWhereInputDto } from '@revisium/client';
import type { ControlPlaneDataAccess, ControlPlaneRow } from '../control-plane/index.js';

export type RunSummary = {
  runId: string;
  title: string;
  status: string;
  priority: number;
  createdAt: string;
};

export type TaskSummary = {
  taskId: string;
  title: string;
  status: string;
  roleHint: string;
};

export type RunDetail = {
  run: RunSummary & { description: string; scope: string; repos: string[] };
  tasks: TaskSummary[];
};

export type EventSummary = {
  eventId: string;
  type: string;
  actor: string;
  createdAt: string;
  taskId: string;
  stepId: string;
  /** Deserialized event payload (output/verdict/reason/…). Surfaced by `run events --verbose`. */
  payload: unknown;
};

export type AttemptSummary = {
  attemptId: string;
  stepId: string;
  iteration: number;
  status: string;
  verdict: string;
  modelProfile: string;
  inputTokens: number;
  outputTokens: number;
  costAmount: number;
  currency: string;
  durationMs: number;
  outputSummary: string;
  artifactRef: string;
  stdoutTail: string;
  stderrTail: string;
  lesson: string;
  error: string;
  startedAt: string;
};

const GLOBAL_CAP = 500;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x));
}

function toRunSummary(row: ControlPlaneRow): RunSummary {
  return {
    runId: row.rowId,
    title: str(row.data.title),
    status: str(row.data.status),
    priority: num(row.data.priority),
    createdAt: str(row.data.created_at ?? row.createdAt),
  };
}

function toRunDetail(row: ControlPlaneRow): RunDetail['run'] {
  return {
    ...toRunSummary(row),
    description: str(row.data.description),
    scope: str(row.data.scope),
    repos: strArr(row.data.repos),
  };
}

function toTaskSummary(row: ControlPlaneRow): TaskSummary {
  return {
    taskId: row.rowId,
    title: str(row.data.title),
    status: str(row.data.status),
    roleHint: str(row.data.role_hint),
  };
}

function toEventSummary(row: ControlPlaneRow): EventSummary {
  return {
    eventId: row.rowId,
    type: str(row.data.type),
    actor: str(row.data.actor),
    createdAt: str(row.data.created_at ?? row.createdAt),
    taskId: str(row.data.task_id),
    stepId: str(row.data.step_id),
    payload: row.data.payload ?? null,
  };
}

function toAttemptSummary(row: ControlPlaneRow): AttemptSummary {
  return {
    attemptId: row.rowId,
    stepId: str(row.data.step_id),
    iteration: num(row.data.iteration),
    status: str(row.data.status),
    verdict: str(row.data.verdict),
    modelProfile: str(row.data.model_profile),
    inputTokens: num(row.data.input_tokens),
    outputTokens: num(row.data.output_tokens),
    costAmount: num(row.data.cost_amount),
    currency: str(row.data.currency) || 'USD',
    durationMs: num(row.data.duration_ms),
    outputSummary: str(row.data.output_summary),
    artifactRef: str(row.data.artifact_ref),
    stdoutTail: str(row.data.stdout_tail),
    stderrTail: str(row.data.stderr_tail),
    lesson: str(row.data.lesson),
    error: str(row.data.error),
    startedAt: str(row.data.started_at ?? row.createdAt),
  };
}

// Prisma path+equals accepts scalar values; the SDK types equals as an object due to generated types.
function runIdWhere(runId: string): RowWhereInputDto {
  return { data: { path: 'run_id', equals: runId as unknown as Record<string, unknown> } };
}

export async function listRuns(
  da: ControlPlaneDataAccess,
  filter?: { status?: string; limit?: number },
): Promise<RunSummary[]> {
  await da.assertReady();
  const rows = await da.listRows('task_runs', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
  });
  if (rows.length === GLOBAL_CAP) {
    process.stderr.write(`warning: task_runs results may be incomplete (cap=${GLOBAL_CAP})\n`);
  }
  let result = rows.map(toRunSummary);
  if (filter?.status) result = result.filter((r) => r.status === filter.status);
  if (filter?.limit !== undefined) result = result.slice(0, filter.limit);
  return result;
}

export async function showRun(da: ControlPlaneDataAccess, runId: string): Promise<RunDetail | null> {
  await da.assertReady();
  const runRow = await da.getRow('task_runs', runId);
  if (!runRow) return null;

  const where = runIdWhere(runId);

  const tasks = await da.listRows('tasks', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
    where,
  });

  return {
    run: toRunDetail(runRow),
    tasks: tasks.map(toTaskSummary),
  };
}

export async function listRunEvents(
  da: ControlPlaneDataAccess,
  runId: string,
  filter?: { type?: string; limit?: number },
): Promise<EventSummary[]> {
  await da.assertReady();
  const rows = await da.listRows('events', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
    where: runIdWhere(runId),
  });
  let events = rows.map(toEventSummary);
  if (filter?.type) events = events.filter((e) => e.type === filter.type);
  if (filter?.limit !== undefined) events = events.slice(0, filter.limit);
  return events;
}

/** List per-attempt observability rows for a run, oldest-first (0008 #4 — `run log`). */
export async function listRunAttempts(
  da: ControlPlaneDataAccess,
  runId: string,
  filter?: { limit?: number },
): Promise<AttemptSummary[]> {
  await da.assertReady();
  const rows = await da.listRows('attempts', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'asc' }],
    where: runIdWhere(runId),
  });
  let attempts = rows.map(toAttemptSummary);
  if (filter?.limit !== undefined) attempts = attempts.slice(0, filter.limit);
  return attempts;
}

/**
 * getRunFailure — read the run-row status + the persisted run_failed reason (0008 #2).
 *
 * Used by `run start --wait` so a FAILURE terminal DBOS status surfaces WHY the run failed
 * instead of a bare "status: ERROR". Returns null when the run does not exist.
 */
export async function getRunFailure(
  da: ControlPlaneDataAccess,
  runId: string,
): Promise<{ runStatus: string; reason?: string } | null> {
  await da.assertReady();
  const runRow = await da.getRow('task_runs', runId);
  if (!runRow) return null;
  const runStatus = str(runRow.data.status);

  const rows = await da.listRows('events', {
    first: GLOBAL_CAP,
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
    where: runIdWhere(runId),
  });
  const failed = rows.find((r) => str(r.data.type) === 'run_failed');
  const payload = failed?.data.payload;
  const reason =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).reason
      : undefined;
  return { runStatus, reason: typeof reason === 'string' && reason.length > 0 ? reason : undefined };
}

// ─────────────────────── formatters ───────────────────────

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

export function formatRunList(runs: RunSummary[]): string {
  const COL = { id: 27, status: 8, pri: 5, ts: 22, title: 0 };
  const header =
    pad('RUN', COL.id) +
    pad('STATUS', COL.status) +
    pad('PRI', COL.pri) +
    pad('CREATED', COL.ts) +
    'TITLE';
  const lines = runs.map((r) => {
    const ts = r.createdAt ? r.createdAt.slice(0, 19) + 'Z' : '';
    return (
      pad(r.runId, COL.id) +
      pad(r.status, COL.status) +
      pad(String(r.priority), COL.pri) +
      pad(ts, COL.ts) +
      r.title
    );
  });
  const summary = `(${runs.length} run${runs.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}

export function formatRunDetail(detail: RunDetail): string {
  const r = detail.run;
  const ts = r.createdAt ? r.createdAt.slice(0, 19) + 'Z' : '';
  const lines: string[] = [
    `run     ${r.runId}`,
    `status  ${r.status}`,
    `title   ${r.title}`,
    `created ${ts}`,
  ];
  if (r.description) lines.push(`desc    ${r.description}`);
  if (r.scope) lines.push(`scope   ${r.scope}`);
  if (r.repos.length > 0) lines.push(`repos   ${r.repos.join(', ')}`);
  lines.push('');

  for (const task of detail.tasks) {
    lines.push(
      `  task     ${task.taskId}`,
      `  title    ${task.title}`,
      `  status   ${task.status}`,
      `  role     ${task.roleHint}`,
    );
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatEventList(events: EventSummary[]): string {
  const COL = { id: 45, type: 16, actor: 14, ts: 22 };
  const header =
    pad('EVENT', COL.id) +
    pad('TYPE', COL.type) +
    pad('ACTOR', COL.actor) +
    'CREATED';
  const lines = events.map((e) => {
    const ts = e.createdAt ? e.createdAt.slice(0, 19) + 'Z' : '';
    return (
      pad(e.eventId, COL.id) +
      pad(e.type, COL.type) +
      pad(e.actor, COL.actor) +
      ts
    );
  });
  const summary = `(${events.length} event${events.length === 1 ? '' : 's'})`;
  return [header, ...lines, summary].join('\n');
}

/**
 * formatEventListVerbose — like formatRunEvents but expands each event's payload (0008 #4).
 * Surfaces the agent output / verdict / reason that the compact table drops.
 */
export function formatEventListVerbose(events: EventSummary[]): string {
  const blocks = events.map((e) => {
    const ts = e.createdAt ? e.createdAt.slice(0, 19) + 'Z' : '';
    const head = `${e.type}  actor=${e.actor}  ${ts}  (${e.eventId})`;
    const payloadJson = JSON.stringify(e.payload ?? null, null, 2)
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n');
    return `${head}\n${payloadJson}`;
  });
  const summary = `(${events.length} event${events.length === 1 ? '' : 's'})`;
  return [...blocks, summary].join('\n');
}

/** Two-decimal USD; '$0.0000' is overly noisy, so show 4 dp only when sub-cent. */
function fmtUsd(amount: number): string {
  return amount > 0 && amount < 0.01 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

/**
 * formatAttemptList — per-attempt observability dump for `run log <runId>` (0008 #4).
 * Shows verdict, model, tokens, cost, duration, iteration, status, and the output summary.
 */
export function formatAttemptList(attempts: AttemptSummary[]): string {
  if (attempts.length === 0) return '(0 attempts)';
  const blocks = attempts.map((a) => {
    const lines = [
      `attempt  ${a.attemptId}  step=${a.stepId}`,
      `  iter=${a.iteration}  status=${a.status}  verdict=${a.verdict || '-'}  model=${a.modelProfile || '-'}`,
      `  tokens=${a.inputTokens}in/${a.outputTokens}out  cost=${fmtUsd(a.costAmount)}  duration=${a.durationMs}ms`,
    ];
    if (a.artifactRef) lines.push(`  artifact ${a.artifactRef}`);
    if (a.outputSummary) lines.push(`  output   ${a.outputSummary}`);
    if (a.stdoutTail) lines.push(`  stdout   ${a.stdoutTail}`);
    if (a.stderrTail) lines.push(`  stderr   ${a.stderrTail}`);
    if (a.lesson) lines.push(`  lesson   ${a.lesson}`);
    if (a.error) lines.push(`  error    ${a.error}`);
    return lines.join('\n');
  });
  const summary = `(${attempts.length} attempt${attempts.length === 1 ? '' : 's'})`;
  return [...blocks, summary].join('\n');
}
