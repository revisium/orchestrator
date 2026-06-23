import type { INestApplicationContext } from '@nestjs/common';
import { Command } from 'commander';
import { readPackageVersion } from '../package-info.js';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerDev } from './commands/dev.js';
import { registerInbox } from './commands/inbox.js';
import { registerLifecycle } from './commands/lifecycle.js';
import { registerMcp } from './commands/mcp.js';
import { registerPlaybook } from './commands/playbook.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';
import { registerServe } from './commands/serve.js';

export { readPackageVersion };

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
  registerLifecycle(program);
  registerRevisium(program);
  registerBootstrap(program);
  registerPlaybook(program);
  registerRun(program, app);
  registerInbox(program, app); // G6: forward app so gate resolve path can access DbosService
  registerMcp(program, app);
  registerDev(program, app);
  registerServe(program);
  return program;
}
