import { readFileSync } from 'node:fs';
import type { INestApplicationContext } from '@nestjs/common';
import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerDev } from './commands/dev.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';
import { registerWork } from './commands/work.js';

// Read the version from package.json at runtime. A static JSON import is avoided: tsconfig has no
// resolveJsonModule and package.json lives outside rootDir ("src"). '../../package.json' is correct
// from this file in BOTH dev (tsx src/cli/program.ts) and the built output (dist/cli/program.js) —
// each sits exactly two levels below the repo root (bin/revo.js runs dist/cli/index.js).
export function readPackageVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (typeof pkg.version !== 'string' || pkg.version === '') {
    throw new Error('package.json is missing a "version" field');
  }
  return pkg.version;
}

/**
 * Build the commander program.
 *
 * @param app - Optional Nest app context (host path only).
 *   - When `app` is provided, dev:ping/dev:status actions are wired to the DI context.
 *   - When `app` is absent (host-free path or tests), dev command DEFINITIONS are still
 *     registered so `dev:ping --help` works; actions guard on the absent `app`.
 *   - The no-arg overload is preserved for program.test.ts compatibility.
 */
export function buildProgram(app?: INestApplicationContext): Command {
  const program = new Command();
  program
    .name('revo')
    .description('Agent orchestrator CLI')
    .version(readPackageVersion(), '-v, --version', 'Print the revo version');
  registerRevisium(program);
  registerBootstrap(program);
  registerRun(program);
  registerWork(program);
  registerDev(program, app);
  return program;
}
