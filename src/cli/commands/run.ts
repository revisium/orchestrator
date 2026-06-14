/**
 * run.ts — CLI commands for managing orchestrator runs.
 *
 * Routes through RunService obtained from a per-invocation Revisium-only Nest context
 * (Option A, §3.0). NestJS is lazily imported so the host-free path never loads it.
 *
 * `run start` is host-requiring (enqueues a DBOS workflow) and receives the optional `app`
 * context forwarded from buildProgram. All other run subcommands remain host-free.
 *
 * Invariant #4: no @revisium/client import in this file (verbs only; mapping stays
 * inside the control-plane/run layer that RevisiumModule fronts).
 *
 * M5 (TASK 0003): `registerRun(program, app?)` — lazy pipeline import like dev.ts (F10).
 *
 * 0006 (B+C): createRunCore exported for unit testing. Validates all start-mode
 * preconditions BEFORE writing any rows, so invalid private runner-test combos
 * leave zero orphan drafts. Production createRun routes through the task-control-plane API.
 */
import { Command } from 'commander';
import type { INestApplicationContext } from '@nestjs/common';
import { ControlPlaneError } from '../../control-plane/index.js';
import { CreateRunWorkflowError, type CreateRunInput } from '../../run/create-run.js';
import { formatRunList, formatRunDetail, formatEventList, formatEventListVerbose, formatAttemptList } from '../../run/inspect-run.js';
import type { RunService } from '../../revisium/run.service.js';
import { withRevisiumService } from './revisium-context.js';
import { sanitizeWorkflowID } from './dev.js';
import { pollWorkflowState, type PollOpts } from './poll-workflow-state.js';
import { assertNoStubLive, warnLiveCost } from '../live-guard.js';

type StartOptions = {
  wait: boolean;
};

type CreateOptions = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  playbookId?: string;
  pipelineId?: string;
  params?: string;
  priority: string;
  /** Deprecated private test seam; no longer registered as a public CLI option. */
  role?: string;
  start: boolean;
  wait: boolean;
  /** Deprecated private test seam; no longer registered as a public CLI option. */
  stub?: boolean;
  /** Deprecated private test seam; no longer registered as a public CLI option. */
  live?: boolean;
};

type ListOptions = {
  status?: string;
  limit?: string;
  json: boolean;
};

type ShowOptions = {
  json: boolean;
};

type EventsOptions = {
  type?: string;
  limit?: string;
  json: boolean;
  verbose: boolean;
};

type LogOptions = {
  limit?: string;
  json: boolean;
};

async function resolveTaskControlPlaneApi(app: INestApplicationContext) {
  const { TaskControlPlaneApiService } = await import('../../task-control-plane/task-control-plane-api.service.js');
  return app.get(TaskControlPlaneApiService);
}

/**
 * runPollWorkflowState — thin wrapper that opens an InboxService context and
 * delegates to the shared pollWorkflowState helper (poll-workflow-state.ts).
 *
 * Extracted to a local wrapper so runStart can call pollWorkflowState without
 * holding an open Nest context for the full start flow.
 */
async function runPollWorkflowState(
  runId: string,
  dbosService: { getWorkflowStatus: (id: string) => Promise<{ status: string } | null> },
  pollOpts: PollOpts = {},
): Promise<void> {
  const { InboxService: InboxServiceClass } = await import('../../revisium/inbox.service.js');
  const { RunService: RunServiceClass } = await import('../../revisium/run.service.js');
  // 0008 #2: surface the run_failed reason on a FAILURE terminal status. The reader opens its own
  // short-lived Revisium context per call (the poll loop only reads it once, on the terminal tick).
  const readFailure: PollOpts['readFailure'] = (id) =>
    withRevisiumService(RunServiceClass, (svc) => svc.getRunFailure(id));
  await withRevisiumService(InboxServiceClass, (inboxSvc) =>
    pollWorkflowState(runId, dbosService, inboxSvc, { ...pollOpts, readFailure }),
  );
}

/**
 * RunStartDeps — injectable service verbs for runStartCore (C1: enables unit testing).
 *
 * Production wiring: built by runStart from the Nest app context + withRevisiumService.
 * Tests: inject fakes directly, skipping NestJS context creation entirely.
 */
export type RunStartDeps = {
  /** Look up a run by ID. Returns null if not found. */
  getRun: (runId: string) => Promise<{ rowId: string; data: Record<string, unknown> } | null>;
  /** Get the DBOS workflow status (null = not started). */
  getWorkflowStatus: (id: string) => Promise<{ status: string } | null>;
  /** Enqueue / idempotently start the pipeline workflow. */
  startDevelopTask: (
    runId: string,
    opts: { runnerMode: 'script' | 'live' },
  ) => Promise<{ workflowID: string }>;
  /** Poll until the workflow reaches a parked or terminal state. */
  pollState: (runId: string, pollOpts?: PollOpts) => Promise<void>;
};

/**
 * runStartCore — testable core of `run start`.
 *
 * Deprecated private compatibility seam for older route-less unit tests.
 * Production `run start` routes through TaskControlPlaneApiService.startRun.
 */
export async function runStartCore(
  safeRunId: string,
  options: { stub: boolean; live: boolean; wait?: boolean },
  deps: RunStartDeps,
): Promise<void> {
  // Validate contradictory private runner-test options.
  if (!assertNoStubLive(options.stub ?? false, options.live ?? false)) return;

  // E12: pre-check the run exists in Revisium before enqueueing.
  const runRow = await deps.getRun(safeRunId);
  if (!runRow) {
    console.error(`run not found: ${safeRunId}`);
    process.exitCode = 1;
    return;
  }

  // Emit cost/effect warning BEFORE enqueue (live mode).
  if (options.live) warnLiveCost();

  const existingStatus = await deps.getWorkflowStatus(safeRunId);

  // Private legacy fallback: live test option → 'live'; default/stub test option → 'script'.
  const runnerMode = options.live ? ('live' as const) : ('script' as const);
  const handle = await deps.startDevelopTask(safeRunId, { runnerMode });

  if (existingStatus !== null) {
    console.log(
      'note: this run was already started — the runner cannot be changed after the first start.',
    );
    console.log('      to use a different runner, create a new run with a new runId.');
    console.log(`workflow: ${handle.workflowID}`);
  } else {
    console.log(`workflow: ${handle.workflowID}`);
    if (options.stub) {
      console.log('stub: private compatibility stub option is active.');
    }
    if (options.live) {
      console.log('live: private compatibility live option is active.');
    }
  }

  // 0004 §3.6: poll for parked or terminal state; thread --wait through to the viewer.
  console.log('awaiting settled state (parked or terminal)…');
  await deps.pollState(safeRunId, { wait: options.wait ?? false });
}

/**
 * Host-requiring: enqueues the developTask DBOS workflow for the given runId.
 * B10: start is idempotent by workflowID=runId. A later start returns the existing
 * handle and does NOT switch the persisted route.
 *
 * 0004 §3.6: no longer blocks on waitForWorkflowResult (the workflow parks at recv).
 * Instead, polls getWorkflowStatus (terminal) + listInbox (parked) and returns once settled.
 * The workflow's DBOS checkpoint persists; shutting down the host while parked is safe.
 */
async function runStart(
  runId: string,
  options: StartOptions,
  app: INestApplicationContext | undefined,
): Promise<void> {
  if (!app) {
    console.error('run start requires the host context — invoke via the host path');
    process.exitCode = 1;
    return;
  }

  // E11: validate the runId before any enqueue.
  let safeRunId: string;
  try {
    safeRunId = sanitizeWorkflowID(runId);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  try {
    const { DbosService: DbosServiceClass } = await import('../../engine/dbos.service.js');
    const dbosService = app.get(DbosServiceClass);
    const api = await resolveTaskControlPlaneApi(app);
    const result = await api.startRun({ runId: safeRunId });
    if (result.alreadyStarted) {
      console.log(`workflow: ${result.workflowID} (already started)`);
    } else {
      console.log(`workflow: ${result.workflowID}`);
    }
    console.log(`pipeline: ${result.route.pipelineId}`);
    console.log('awaiting settled state (parked or terminal)…');
    await runPollWorkflowState(safeRunId, dbosService, { wait: options.wait ?? false });
  } catch (error) {
    reportRunCliError(error);
  }
}

/**
 * reportRunCliError — shared error reporter for the `run` subcommands.
 * Prints a uniform Error line (+ hint for ControlPlaneError) and sets exitCode=1.
 * Extracted to remove the catch-block duplication the per-command handlers shared.
 */
export function reportRunCliError(error: unknown): void {
  if (error instanceof ControlPlaneError) {
    console.error(`Error: ${formatCause(error)}`);
    printHint(error, false);
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${String(error)}`);
  }
  process.exitCode = 1;
}

export function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function printHint(error: ControlPlaneError, createdRows: boolean): void {
  if (error.code === 'DAEMON_NOT_RUNNING') {
    console.error('Run: ./bin/revo.js revisium start');
  }
  if (error.code === 'BOOTSTRAP_NOT_APPLIED' && !createdRows) {
    console.error('Run: ./bin/revo.js bootstrap --commit');
  }
}

function parsePriority(value: string): number {
  const priority = Number(value);
  if (!Number.isFinite(priority) || !Number.isInteger(priority)) {
    throw new TypeError(`Invalid priority: ${value}`);
  }
  return priority;
}

function parseParams(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`Invalid --params JSON: ${message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Invalid --params: expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function parseLimit(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${flag}: ${value} (must be a positive integer)`);
  }
  return n;
}

/**
 * withRunService — thin wrapper around the shared withRevisiumService helper.
 * Opens exactly ONE Nest context per invocation and closes it in finally.
 */
async function withRunService<T>(fn: (svc: RunService) => Promise<T>): Promise<T> {
  const { RunService: RunServiceClass } = await import('../../revisium/run.service.js');
  return withRevisiumService(RunServiceClass, fn);
}

/**
 * CreateRunDeps — injectable deps for createRunCore (mirrors RunStartDeps pattern).
 *
 * Production wiring: built by createRun from the live context.
 * Tests: inject fakes directly, skipping NestJS context creation entirely.
 */
export type CreateRunDeps = {
  /** Create the run/task/step/event and return IDs. */
  createRunFn: (input: CreateRunInput) => Promise<{ runId: string; taskId: string; stepId: string; status: string; eventId: string }>;
  /** Start the pipeline for a given runId (host-requiring). */
  runStart: (runId: string, opts: { stub: boolean; live: boolean; wait: boolean }) => Promise<void>;
  /** The host app context — present only on the host path. */
  app: INestApplicationContext | undefined;
};

/**
 * createRunCore — testable core of `run create`.
 *
 * Exported for unit tests (mirrors C1 pattern from runStartCore): tests inject fake
 * CreateRunDeps and assert the correct error paths WITHOUT creating a NestJS context.
 * Production: called by createRun after building the real deps.
 *
 * Key invariant (B+C fix): ALL start-mode preconditions are validated BEFORE any write.
 * If validation fails, NO run is created and process.exitCode is set to 1.
 *   (a) --start without app → host-required error, return, zero writes.
 *   (b) contradictory private runner-test options → return, zero writes.
 * Only after both checks pass is createRunFn called, then runStart exactly once.
 *
 * Cost-guard coverage remains here only for the private route-less compatibility seam.
 */
export async function createRunCore(
  options: CreateOptions,
  deps: CreateRunDeps,
): Promise<void> {
  // Validate start-mode preconditions BEFORE any write (B+C fix: no orphan drafts).
  if (options.start) {
    if (!deps.app) {
      console.error('run create --start requires the host context — invoke via the host path');
      process.exitCode = 1;
      return;
    }
    // assertNoStubLive returns false and sets exitCode=1 on contradiction.
    if (!assertNoStubLive(options.stub ?? false, options.live ?? false)) {
      return;
    }
  }

  // Validation passed (or non-start path) — proceed with the write.
  const result = await deps.createRunFn({
    title: options.title,
    repo: options.repo,
    description: options.description,
    scope: options.scope,
    playbookId: options.playbookId,
    pipelineId: options.pipelineId,
    params: parseParams(options.params),
    priority: parsePriority(options.priority),
    role: options.role,
  });

  console.log(`created run ${result.runId}`);
  console.log(`task ${result.taskId}`);
  console.log(`step ${result.stepId} ${result.status}`);
  console.log(`event ${result.eventId}`);
  console.log('status: ready (draft only, not committed)');

  // --start: chain into runStart exactly once (no inline second enqueue).
  if (options.start) {
    await deps.runStart(result.runId, {
      stub: options.stub ?? false,
      live: options.live ?? false,
      wait: options.wait,
    });
  }
}

async function createRun(options: CreateOptions, app?: INestApplicationContext): Promise<void> {
  try {
    if (!app) {
      console.error('run create requires the host context — invoke via the host path');
      process.exitCode = 1;
      return;
    }
    const api = await resolveTaskControlPlaneApi(app);
    const result = await api.createRun({
      title: options.title,
      repo: options.repo,
      description: options.description,
      scope: options.scope,
      priority: parsePriority(options.priority),
      playbookId: options.playbookId,
      pipelineId: options.pipelineId,
      params: parseParams(options.params),
      start: options.start,
    });
    console.log(`created run ${result.runId}`);
    console.log(`task ${result.taskId}`);
    console.log(`step ${result.stepId} ${result.status}`);
    console.log(`event ${result.eventId}`);
    const pipelineId = 'workflow' in result ? result.workflow.route.pipelineId : result.route.pipelineId;
    console.log(`pipeline: ${pipelineId}`);
    console.log('status: ready (draft only, not committed)');
    if (options.start && options.wait) {
      const { DbosService: DbosServiceClass } = await import('../../engine/dbos.service.js');
      await runPollWorkflowState(result.runId, app.get(DbosServiceClass), { wait: true });
    }
  } catch (error) {
    if (error instanceof CreateRunWorkflowError) {
      console.error(`Error: ${error.message}: ${formatCause(error.cause)}`);
      if (Object.keys(error.createdIds).length > 0) {
        console.error(`created before failure: ${JSON.stringify(error.createdIds)}`);
      }
      if (error.cause instanceof ControlPlaneError) {
        printHint(error.cause, Object.keys(error.createdIds).length > 0);
      }
      process.exitCode = 1;
    } else {
      reportRunCliError(error);
    }
  }
}

async function runList(options: ListOptions): Promise<void> {
  try {
    const limit = parseLimit(options.limit, '--limit');
    const runs = await withRunService((svc) => svc.listRuns({ status: options.status, limit }));
    if (options.json) {
      process.stdout.write(JSON.stringify(runs, null, 2) + '\n');
    } else {
      console.log(formatRunList(runs));
    }
  } catch (error) {
    reportRunCliError(error);
  }
}

async function runShow(runId: string, options: ShowOptions): Promise<void> {
  try {
    const detail = await withRunService((svc) => svc.showRun(runId));
    if (!detail) {
      console.error(`run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(detail, null, 2) + '\n');
    } else {
      console.log(formatRunDetail(detail));
    }
  } catch (error) {
    reportRunCliError(error);
  }
}

async function runEvents(runId: string, options: EventsOptions): Promise<void> {
  try {
    const limit = parseLimit(options.limit, '--limit');
    // Both reads happen inside ONE Nest context (C2 fix: no two separate withRunService calls).
    await withRunService(async (svc) => {
      const found = await svc.getRun(runId);
      if (!found) {
        console.error(`run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }
      const events = await svc.listRunEvents(runId, { type: options.type, limit });
      if (options.json) {
        process.stdout.write(JSON.stringify(events, null, 2) + '\n');
      } else if (options.verbose) {
        console.log(formatEventListVerbose(events));
      } else {
        console.log(formatEventList(events));
      }
    });
  } catch (error) {
    reportRunCliError(error);
  }
}

/**
 * run log <runId> — per-attempt observability dump (0008 #4).
 * Reads the previously-unused attempts table: output summary, verdict, model, tokens, cost,
 * duration, iteration, status — closing the dogfood's "agent output not surfaced" gap.
 */
async function runLog(runId: string, options: LogOptions): Promise<void> {
  try {
    const limit = parseLimit(options.limit, '--limit');
    await withRunService(async (svc) => {
      const found = await svc.getRun(runId);
      if (!found) {
        console.error(`run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }
      const attempts = await svc.listRunAttempts(runId, { limit });
      if (options.json) {
        process.stdout.write(JSON.stringify(attempts, null, 2) + '\n');
      } else {
        console.log(formatAttemptList(attempts));
      }
    });
  } catch (error) {
    reportRunCliError(error);
  }
}

async function runCancel(runId: string): Promise<void> {
  try {
    const result = await withRunService((svc) => svc.cancelRun(runId));
    if (!result) {
      console.error(`run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    if (result.previousStatus === 'cancelled') {
      console.log(`run ${result.runId} already cancelled`);
    } else {
      console.log(`cancelled run ${result.runId} (was ${result.previousStatus})`);
    }
  } catch (error) {
    reportRunCliError(error);
  }
}

export function registerRun(program: Command, app?: INestApplicationContext): void {
  const run = program.command('run').description('Manage orchestrator runs');

  run
    .command('start')
    .description('Start the pipeline workflow for a run (host-requiring)')
    .argument('<runId>', 'Run ID to start')
    .option(
      '--wait',
      'Keep a live viewer attached through step transitions until the run parks at a gate or finishes',
      false,
    )
    .action((runId: string, options: StartOptions) => runStart(runId, options, app));

  run
    .command('create')
    .requiredOption('--title <title>', 'Run title')
    .requiredOption('--repo <path-or-name>', 'Repository path or name')
    .option('--description <text>', 'Run description')
    .option('--scope <text>', 'Run scope')
    .option('--playbook-id <id>', 'Installed playbook row id')
    .option('--pipeline-id <id>', 'Installed pipeline row id or playbook pipeline id')
    .option('--params <json>', 'Public route params as a JSON object')
    .option('--priority <n>', 'Run priority', '0')
    .option('--start', 'Immediately start the pipeline workflow after creating the run (host-requiring)', false)
    .option(
      '--wait',
      'After starting, keep a live viewer attached until the run parks at a gate or finishes',
      false,
    )
    .action((options: CreateOptions) => createRun(options, app));

  run
    .command('list')
    .description('List runs')
    .option('--status <status>', 'Filter by status')
    .option('--limit <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON', false)
    .action(runList);

  run
    .command('show')
    .description('Show run details')
    .argument('<runId>', 'Run ID')
    .option('--json', 'Output as JSON', false)
    .action(runShow);

  run
    .command('events')
    .description('List events for a run')
    .argument('<runId>', 'Run ID')
    .option('--type <type>', 'Filter by event type')
    .option('--limit <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON', false)
    .option('--verbose', 'Expand each event payload (agent output, verdict, reason)', false)
    .action(runEvents);

  run
    .command('log')
    .description('Show per-attempt log for a run (output, verdict, model, tokens, cost, duration)')
    .argument('<runId>', 'Run ID')
    .option('--limit <n>', 'Maximum number of results')
    .option('--json', 'Output as JSON', false)
    .action(runLog);

  run
    .command('cancel')
    .description('Cancel a run')
    .argument('<runId>', 'Run ID')
    .action(runCancel);
}
