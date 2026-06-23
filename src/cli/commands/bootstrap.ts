import { Command } from 'commander';
import { isHealthy, resolvePorts } from '../config.js';
import { bootstrapControlPlane } from '../../control-plane/bootstrap.js';
import {
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
  type SeedDefaultPlaybookResult,
} from '../../control-plane/seed-default-playbook.js';
import { withRevisiumService } from './revisium-context.js';

type BootstrapOptions = {
  commit?: boolean;
};

/** Run the default-playbook seed against the live draft scope (needs a running daemon). */
async function runDefaultPlaybookSeed(): Promise<SeedDefaultPlaybookResult> {
  return withRevisiumService(
    (await import('../../revisium/playbooks.service.js')).PlaybooksService,
    (service) => seedDefaultPlaybook(service),
  );
}

async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const { httpPort } = await resolvePorts();
  if (!(await isHealthy(httpPort))) {
    console.error('Revisium is not running. Run: revo start');
    process.exitCode = 1;
    return;
  }

  // In-process bootstrap (no external tool) on one draft scope: project + REST endpoint + schema +
  // seed rows, committed once. The same path `revo start` runs on the daemon.
  await bootstrapControlPlane(httpPort);

  // Seed the built-in default playbook once the schema is in place (best-effort).
  if (options.commit !== false) {
    await seedDefaultPlaybookBestEffort(runDefaultPlaybookSeed);
  }
}

export function registerBootstrap(program: Command): void {
  program
    .command('bootstrap')
    .description('Bootstrap the control-plane schema')
    .option('--commit', 'Commit schema changes', true)
    .option('--no-commit', 'Skip seeding the default playbook')
    .action(runBootstrap);
}
