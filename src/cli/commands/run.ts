import { Command } from 'commander';
import { ControlPlaneError, createControlPlaneDataAccess } from '../../control-plane/index.js';
import { createRunWorkflow, CreateRunWorkflowError } from '../../run/create-run.js';
import { listRuns, showRun, listRunEvents, formatRunList, formatRunDetail, formatEventList } from '../../run/inspect-run.js';

type CreateOptions = {
  title: string;
  repo: string;
  description?: string;
  scope?: string;
  priority: string;
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

function formatCause(error: unknown): string {
  if (error instanceof ControlPlaneError) {
    const status = error.status === undefined ? '' : ` status=${error.status}`;
    return `${error.code}${status}: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function printHint(error: ControlPlaneError, createdRows: boolean): void {
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

async function createRun(options: CreateOptions): Promise<void> {
  try {
    const result = await createRunWorkflow(createControlPlaneDataAccess(), {
      title: options.title,
      repo: options.repo,
      description: options.description,
      scope: options.scope,
      priority: parsePriority(options.priority),
    });

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

function parseLimit(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid ${flag}: ${value} (must be a positive integer)`);
  }
  return n;
}

async function runList(options: ListOptions): Promise<void> {
  try {
    const limit = parseLimit(options.limit, '--limit');
    const da = createControlPlaneDataAccess();
    const runs = await listRuns(da, { status: options.status, limit });
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
    const da = createControlPlaneDataAccess();
    const detail = await showRun(da, runId);
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
    const da = createControlPlaneDataAccess();
    const runRow = await da.getRow('task_runs', runId);
    if (!runRow) {
      console.error(`run not found: ${runId}`);
      process.exitCode = 1;
      return;
    }
    const events = await listRunEvents(da, runId, { type: options.type, limit });
    if (options.json) {
      process.stdout.write(JSON.stringify(events, null, 2) + '\n');
    } else {
      console.log(formatEventList(events));
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

export function registerRun(program: Command): void {
  const run = program.command('run').description('Manage orchestrator runs');

  run
    .command('create')
    .requiredOption('--title <title>', 'Run title')
    .requiredOption('--repo <path-or-name>', 'Repository path or name')
    .option('--description <text>', 'Run description')
    .option('--scope <text>', 'Run scope')
    .option('--priority <n>', 'Run priority', '0')
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
}
