/**
 * Dev commands — dev:ping and dev:status.
 *
 * These are host-requiring commands (needsHost() returns true for them).
 * The `app` parameter is optional so command DEFINITIONS are always registered
 * (for `dev:ping --help` to work on the host-free path — consensus MINOR, codex round 2).
 *
 * IMPORTANT — lazy engine import (F10):
 *   This module is statically imported by program.ts (and therefore by buildProgram),
 *   which runs on BOTH the host-free and host paths. To keep the host-free path engine-free
 *   (ТЗ §3.7), DbosService is imported LAZILY inside each action function — never at module
 *   load time. `import type` is used for the type annotation only (erased at runtime).
 *
 * dev:ping  — start the two-step durable workflow.
 *   Note: blocks for ~--sleep ms on the happy path (step2 sleeps for durable-execution demo).
 *   For a quick test use --sleep 100.
 *
 * dev:status <id> — recover-and-wait on an existing workflow id.
 *   Used by the resume acceptance test (E10, F2): after a kill -9, run this command
 *   to have DBOS auto-recover the original workflow and await its result.
 */

import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { DbosService } from '../../engine/dbos.service.js';
import { Command } from 'commander';
import { getConfig, readRuntime } from '../config.js';

type PingOptions = {
  sleep: string;
  id?: string;
};

function resolveMarkerFile(workflowID: string): string {
  const runtime = readRuntime();
  const dataDir = runtime?.dataDir ?? getConfig().dataDir;
  return join(dataDir, `dev-ping-${workflowID}.marker`);
}

/** Lazily resolve DbosService from the Nest app context (F10: no static engine import). */
async function resolveDbosService(app: INestApplicationContext): Promise<DbosService> {
  // Dynamic import: only loads @nestjs/common + @dbos-inc/dbos-sdk when the action runs,
  // which happens exclusively on the host path where NestFactory has already been called.
  const { DbosService: DbosServiceClass } = await import('../../engine/dbos.service.js');
  return app.get(DbosServiceClass);
}

async function runDevPing(options: PingOptions, app: INestApplicationContext | undefined): Promise<void> {
  if (!app) {
    console.error('dev commands require the host context — invoke via the host path');
    process.exitCode = 1;
    return;
  }

  const sleepMs = Number(options.sleep);
  if (!Number.isInteger(sleepMs) || sleepMs < 0) {
    console.error(`Invalid --sleep value: ${options.sleep}`);
    process.exitCode = 1;
    return;
  }

  const dbosService = await resolveDbosService(app);
  const workflowID = options.id ?? `dev-ping-${Date.now()}`;
  const markerFile = resolveMarkerFile(workflowID);

  console.log(`Starting dev:ping workflow (id=${workflowID}, sleep=${sleepMs}ms)...`);
  const handle = await dbosService.startPingWorkflow(workflowID, sleepMs, markerFile);
  console.log(`Workflow started. Awaiting result (will block ~${sleepMs}ms)...`);
  const result = await handle.getResult();
  const status = await dbosService.getWorkflowStatus(handle.workflowID);
  console.log(`Workflow ID:    ${result.workflowID}`);
  console.log(`Status:         ${status?.status ?? 'unknown'}`);
  console.log(`Marker count:   ${result.markerCount}`);
  console.log(`Marker file:    ${markerFile}`);
}

async function runDevStatus(
  id: string,
  app: INestApplicationContext | undefined,
): Promise<void> {
  if (!app) {
    console.error('dev commands require the host context — invoke via the host path');
    process.exitCode = 1;
    return;
  }

  const dbosService = await resolveDbosService(app);

  // F14: check existence first — retrieveWorkflow().getResult() hangs for unknown ids.
  const existingStatus = await dbosService.getWorkflowStatus(id);
  if (existingStatus === null) {
    console.error(`workflow ${id} not found`);
    process.exitCode = 1;
    return;
  }

  console.log(`Waiting for workflow ${id} to complete (DBOS auto-recovery active)...`);
  const result = await dbosService.waitForWorkflow(id);
  if (result === null) {
    // Should not happen after getWorkflowStatus returned non-null, but guard for safety.
    console.error(`workflow ${id} completed with no result`);
    process.exitCode = 1;
    return;
  }

  console.log(`Workflow ID:    ${result.workflowID}`);
  console.log(`Status:         ${existingStatus.status ?? 'unknown'}`);
  console.log(`Marker count:   ${result.markerCount}`);
  console.log(`Marker file:    ${resolveMarkerFile(id)}`);
}

export function registerDev(program: Command, app?: INestApplicationContext): void {
  program
    .command('dev:ping')
    .description(
      'Start the dev:ping durable workflow (blocks ~--sleep ms; use --sleep 100 for a quick test)',
    )
    .option('--sleep <ms>', 'Duration of step2 sleep in milliseconds', '15000')
    .option('--id <workflowID>', 'Stable workflow ID for the resume test')
    .action((options: PingOptions) => runDevPing(options, app));

  program
    .command('dev:status <id>')
    .description(
      'Wait for a dev:ping workflow to complete (uses DBOS recovery — for the resume acceptance test)',
    )
    .action((id: string) => runDevStatus(id, app));
}
