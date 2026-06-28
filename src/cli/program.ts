import { Command } from 'commander';
import { readPackageVersion } from '../package-info.js';
import { registerLifecycle } from './commands/lifecycle.js';
import { registerMcp } from './commands/mcp.js';

export { readPackageVersion };




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
