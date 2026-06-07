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
 */
import { Command } from 'commander';
import type { INestApplicationContext } from '@nestjs/common';
import { ControlPlaneError } from '../../control-plane/index.js';
import { CreateRunWorkflowError, type CreateRunInput } from '../../run/create-run.js';
import { formatRunList, formatRunDetail, formatEventList } from '../../run/inspect-run.js';
import type { RunService } from '../../revisium/run.service.js';
import { withRevisiumService } from './revisium-context.js';
import { sanitizeWorkflowID } from './dev.js';

type StartOptions = {
  stub: boolean;
};

type CreateOptions = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority: string;
  role: string;
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
};

/**
 * Lazily resolve PipelineService from the Nest app context (F10: no static pipeline import).
 * Dynamic import: only loads pipeline code on the host path.
 */
async function resolvePipelineService(app: INestApplicationContext) {
  const { PipelineService } = await import('../../pipeline/develop-task.workflow.js');
  return app.get(PipelineService);
}

/**
 * run start <id> [--stub]
 *
 * Host-requiring: enqueues the developTask DBOS workflow for the given runId.
 * `--stub` forces zero-cost stub runner via the durable runnerOverride arg (B4).
 *
 * B10: start is idempotent by workflowID=runId. `--stub` only takes effect on the FIRST
 * start; a subsequent `run start --stub` on an already-started run returns the existing
 * handle and does NOT switch the runner (DBOS does not overwrite persisted args).
 * To switch, create a NEW run (new runId) and start that with --stub.
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
    // E12: pre-check the run exists in Revisium before enqueueing.
    const { RunService: RunServiceClass } = await import('../../revisium/run.service.js');
    const runRow = await withRevisiumService(RunServiceClass, (svc) => svc.getRun(safeRunId));
    if (!runRow) {
      console.error(`run not found: ${safeRunId}`);
      process.exitCode = 1;
      return;
    }

    // Check for an existing workflow before enqueueing (B10 duplicate-start detection).
    const { DbosService: DbosServiceClass } = await import('../../engine/dbos.service.js');
    const dbosService = app.get(DbosServiceClass);
    const existingStatus = await dbosService.getWorkflowStatus(safeRunId);

    const pipeline = await resolvePipelineService(app);
    const opts = options.stub ? { runnerOverride: 'script' as const } : undefined;
    const handle = await pipeline.startDevelopTask(safeRunId, opts);

    if (existingStatus !== null) {
      console.log(
        'note: this run was already started — the runner cannot be changed after the first start.',
      );
      console.log('      to use a different runner, create a new run with a new runId.');
      console.log(`workflow: ${handle.workflowID}`);
    } else {
      console.log(`workflow: ${handle.workflowID}`);
      if (options.stub) {
        console.log('stub: --stub is active (zero-cost run via stub runner).');
      }
    }

    // C2: await the workflow to completion before the CLI closes the Nest app.
    // This ensures `app.close()` / DBOS.shutdown() does not race the workflow.
    // On a re-run (existing workflow): re-attaches to the existing handle and waits —
    // does NOT double-enqueue (startDevelopTask is idempotent by workflowID=runId).
    console.log('awaiting workflow completion…');
    const result = await dbosService.waitForWorkflowResult<{ runId: string; blocked: boolean; iterations: number; verdict: string }>(handle.workflowID);
    if (result) {
      console.log(`done:     runId=${result.runId}  blocked=${result.blocked}  verdict=${result.verdict}  iterations=${result.iterations}`);
    }
    const finalStatus = await dbosService.getWorkflowStatus(handle.workflowID);
    console.log(`status:   ${finalStatus?.status ?? 'UNKNOWN'}`);
  } catch (error) {
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

async function createRun(options: CreateOptions): Promise<void> {
  try {
    const input: CreateRunInput = {
      title: options.title,
      repo: options.repo,
      description: options.description,
      scope: options.scope,
      priority: parsePriority(options.priority),
      role: options.role,
    };
    const result = await withRunService((svc) => svc.createRun(input));

    console.log(`created run ${result.runId}`);
    console.log(`task ${result.taskId}`);
    console.log(`step ${result.stepId} ${result.status}`);
    console.log(`event ${result.eventId}`);
    console.log('status: ready (draft only, not committed)');
  } catch (error) {
    if (error instanceof CreateRunWorkflowError) {
      console.error(`Error: ${error.message}: ${formatCause(error.cause)}`);
      if (Object.keys(error.createdIds).length > 0) {
        console.error(`created before failure: ${JSON.stringify(error.createdIds)}`);
      }
      if (error.cause instanceof ControlPlaneError) {
        printHint(error.cause, Object.keys(error.createdIds).length > 0);
      }
    } else if (error instanceof ControlPlaneError) {
      console.error(`Error: ${formatCause(error)}`);
      printHint(error, false);
    } else if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error(`Error: ${String(error)}`);
    }
    process.exitCode = 1;
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
      } else {
        console.log(formatEventList(events));
      }
    });
  } catch (error) {
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
}

export function registerRun(program: Command, app?: INestApplicationContext): void {
  const run = program.command('run').description('Manage orchestrator runs');

  run
    .command('start')
    .description('Start the pipeline workflow for a run (host-requiring)')
    .argument('<runId>', 'Run ID to start')
    .option('--stub', 'Use zero-cost stub runner (dev/test only)', false)
    .action((runId: string, options: StartOptions) => runStart(runId, options, app));

  run
    .command('create')
    .requiredOption('--title <title>', 'Run title')
    .requiredOption('--repo <path-or-name>', 'Repository path or name')
    .option('--description <text>', 'Run description')
    .option('--scope <text>', 'Run scope')
    .option('--priority <n>', 'Run priority', '0')
    .option('--role <name>', 'Initial step role (architect|developer|reviewer|integrator|pr-watcher)', 'architect')
    .action(createRun);

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
    .action(runEvents);

  run
    .command('cancel')
    .description('Cancel a run')
    .argument('<runId>', 'Run ID')
    .action(runCancel);
}
