import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Command } from 'commander';
import { isHealthy, repoRoot, resolvePorts, revisiumUri } from '../config.js';
import { applyAdditiveSchemaMigration } from '../../control-plane/schema-migration.js';
import { seedDefaultPlaybook } from '../../control-plane/seed-default-playbook.js';
import { withRevisiumService } from './revisium-context.js';

type BootstrapOptions = {
  commit?: boolean;
};

/**
 * Install the BUILT-IN DEFAULT playbook (slice 5, plan 0015) so a fresh control-plane has a working
 * `feature-development` + `local-change` pipeline out-of-the-box (the default is DATA — a committed
 * playbook source, NOT engine code). Idempotent + best-effort: a fresh bootstrap installs it once;
 * re-running is a no-op. A seed failure must NOT fail the schema bootstrap (the schema is the
 * critical artifact) — it is reported so the operator can re-run `revo playbook install`.
 */
async function seedDefaultPlaybookBestEffort(): Promise<void> {
  try {
    const outcome = await withRevisiumService(
      (await import('../../revisium/playbooks.service.js')).PlaybooksService,
      (service) => seedDefaultPlaybook(service),
    );
    if (outcome.status === 'installed') {
      const { result } = outcome;
      console.error(
        `Seeded default playbook ${result.playbookId} ` +
          `(${result.roles} roles, ${result.pipelines} pipelines).`,
      );
    } else if (outcome.status === 'already-installed') {
      console.error('Default playbook already installed — skipping seed.');
    }
  } catch (err) {
    console.error(
      `Default playbook seed failed (schema bootstrap still applied): ${String(err)}. ` +
        'Re-run with `revo playbook install control-plane/default-playbook --commit`.',
    );
  }
}

async function runBootstrap(options: BootstrapOptions): Promise<void> {
  const { httpPort } = await resolvePorts();

  if (!(await isHealthy(httpPort))) {
    console.error('Revisium is not running. Run: revo revisium start');
    process.exitCode = 1;
    return;
  }

  const configPath = join(repoRoot, 'control-plane', 'bootstrap.config.json');
  const args = [
    '-y',
    'revisium@2.5.0-alpha.6',
    'example',
    'bootstrap',
    '--config',
    configPath,
    '--url',
    revisiumUri(httpPort),
    '--skip-auth',
  ];

  if (options.commit !== false) args.push('--commit');

  const runExternalBootstrap = async (): Promise<number> => {
    const child = spawn('npx', args, { stdio: 'inherit' });
    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', () => resolve(1));
      child.on('exit', resolve);
    });
    return exitCode ?? 1;
  };

  let exitCode = await runExternalBootstrap();
  if (exitCode !== 0) {
    const migration = await applyAdditiveSchemaMigration({
      configPath,
      httpPort,
      commit: options.commit,
    });
    if (migration.patches > 0) {
      console.error(
        `Applied additive schema migration (${migration.patches} patch${migration.patches === 1 ? '' : 'es'}): ` +
          migration.updatedTables.join(', '),
      );
      exitCode = await runExternalBootstrap();
      if (exitCode !== 0) {
        console.error(
          'External bootstrap still reports a schema conflict after additive migration; ' +
            'continuing because runtime-compatible schema patches were applied.',
        );
        exitCode = 0;
      }
    }
  }

  // Seed the built-in default playbook (slice 5) once the schema is in place. Only when committing —
  // a non-committed bootstrap leaves a draft, so installing a non-live playbook would be misleading.
  if (exitCode === 0 && options.commit !== false) {
    await seedDefaultPlaybookBestEffort();
  }

  process.exitCode = exitCode;
}

export function registerBootstrap(program: Command): void {
  program
    .command('bootstrap')
    .description('Bootstrap the control-plane schema')
    .option('--commit', 'Commit schema changes', true)
    .option('--no-commit', 'Run without committing schema changes')
    .action(runBootstrap);
}
