import { Command } from 'commander';
import { readPackageVersion } from '../package-info.js';
import { registerLifecycle } from './commands/lifecycle.js';
import { registerMcp } from './commands/mcp.js';

export { readPackageVersion };

/**
 * Build the Revo CLI. The CLI is lifecycle-only (ADR 0006): `revo start/stop/status/...` manage the
 * whole stack, and `revo mcp` is a thin stdio bridge to the daemon. Orchestration (runs, inbox,
 * method, …) is reached through the daemon's MCP + GraphQL front doors, not the CLI.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('revo')
    .description('Agent orchestrator CLI')
    .version(readPackageVersion(), '-v, --version', 'Print the revo version');
  registerLifecycle(program);
  registerMcp(program);
  return program;
}
