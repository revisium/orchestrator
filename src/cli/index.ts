import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerRevisium } from './commands/revisium.js';
import { registerRun } from './commands/run.js';

const program = new Command();

program.name('revo').description('Agent orchestrator CLI').version('0.0.1');

registerRevisium(program);
registerBootstrap(program);
registerRun(program);

await program.parseAsync(process.argv);
