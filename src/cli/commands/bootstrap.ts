import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { isHealthy, repoRoot, resolvePorts, revisiumUri } from '../config.js';

type BootstrapOptions = {
  commit?: boolean;
};

async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const { httpPort } = await resolvePorts();

  if (!(await isHealthy(httpPort))) {
    console.error('Revisium is not running. Run: revo revisium start');
    process.exitCode = 1;
    return;
  }

  const args = [
    '-y',
    'revisium@2.5.0-alpha.6',
    'example',
    'bootstrap',
    '--config',
    join(repoRoot, 'control-plane', 'bootstrap.config.json'),
    '--url',
    revisiumUri(httpPort),
    '--skip-auth',
  ];

  if (options.commit !== false) args.push('--commit');

  const child = spawn('npx', args, { stdio: 'inherit' });
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('exit', resolve);
  });

  process.exitCode = exitCode ?? 1;
}

export function registerBootstrap(program: Command): void {
  program
    .command('bootstrap')
    .description('Bootstrap the control-plane schema')
    .option('--commit', 'Commit schema changes', true)
    .option('--no-commit', 'Run without committing schema changes')
    .action(runBootstrap);
}
