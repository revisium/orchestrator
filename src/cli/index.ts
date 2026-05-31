import { Command } from 'commander';
import { registerBootstrap } from './commands/bootstrap.js';
import { registerRevisium } from './commands/revisium.js';

const program = new Command();

program.name('revo').description('Agent orchestrator CLI').version('0.0.1');

registerRevisium(program);
registerBootstrap(program);

await program.parseAsync(process.argv);
