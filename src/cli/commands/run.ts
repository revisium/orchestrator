/**
 * run.ts — CLI commands for managing orchestrator runs.
 *
 * Routes through RunService obtained from a per-invocation Revisium-only Nest context
 * (Option A, §3.0). NestJS is lazily imported so the host-free path never loads it.
 * run/inbox stay host-free — NOT added to HOST_COMMANDS, needsHost() unchanged.
 *
 * Invariant #4: no @revisium/client import in this file (verbs only; mapping stays
 * inside the control-plane/run layer that RevisiumModule fronts).
 */
import { Command } from 'commander';
import { ControlPlaneError } from '../../control-plane/index.js';
import { CreateRunWorkflowError, type CreateRunInput } from '../../run/create-run.js';
import { formatRunList, formatRunDetail, formatEventList } from '../../run/inspect-run.js';
import type { RunService } from '../../revisium/run.service.js';
import { withRevisiumService } from './revisium-context.js';

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

export function registerRun(program: Command): void {
  const run = program.command('run').description('Manage orchestrator runs');

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
