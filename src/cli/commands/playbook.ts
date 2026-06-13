import { Command } from 'commander';
import { PlaybookError } from '../../playbook/errors.js';
import type { PlaybookInstallOptions, PlaybookInstallResult } from '../../playbook/playbook-installer.js';
import { withRevisiumService } from './revisium-context.js';

type InstallOptions = {
  commit: boolean;
  dryRun: boolean;
  json: boolean;
  name?: string;
  version?: string;
};

export type PlaybookInstallDeps = {
  install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult>;
};

function formatInstallResult(result: PlaybookInstallResult): string {
  const lines = [
    `playbook: ${result.playbookId}`,
    `name: ${result.name}`,
    `version: ${result.version || '(unversioned)'}`,
    `source: ${result.source}`,
    `roles: ${result.roles}`,
    `pipelines: ${result.pipelines}`,
    `operations: ${result.operations.length}`,
  ];
  if (result.dryRun) {
    lines.push('dry-run: no rows written');
  } else if (result.committed) {
    const revisionSuffix = result.revisionId ? ` (${result.revisionId})` : '';
    lines.push(`committed: yes${revisionSuffix}`);
  } else {
    lines.push('committed: no', 'warning: draft was written but is not live until committed');
  }
  return lines.join('\n');
}

function reportPlaybookError(error: unknown): void {
  if (error instanceof PlaybookError) {
    console.error(`Error: ${error.code}: ${error.message}`);
  } else if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${String(error)}`);
  }
  process.exitCode = 1;
}

export async function installPlaybookCore(
  source: string,
  options: InstallOptions,
  deps: PlaybookInstallDeps,
): Promise<void> {
  try {
    const result = await deps.install({
      source,
      commit: options.commit,
      dryRun: options.dryRun,
      name: options.name,
      version: options.version,
    });
    if (options.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      console.log(formatInstallResult(result));
    }
  } catch (error) {
    reportPlaybookError(error);
  }
}

async function installPlaybook(source: string, options: InstallOptions): Promise<void> {
  const { PlaybooksService } = await import('../../revisium/playbooks.service.js');
  await withRevisiumService(PlaybooksService, (service) => installPlaybookCore(source, options, service));
}

export function registerPlaybook(program: Command): void {
  const playbook = program.command('playbook').description('Manage installed agent playbooks');

  playbook
    .command('install')
    .description('Install a playbook manifest and catalogs into the control plane')
    .argument('<source>', 'Local path or already-resolvable npm package')
    .option('--commit', 'Commit versioned playbook changes after writing draft rows', false)
    .option('--dry-run', 'Validate and print planned changes without writing rows', false)
    .option('--json', 'Output as JSON', false)
    .option('--name <id>', 'Override installed playbook row id')
    .option('--version <version>', 'Override installed playbook version')
    .action((source: string, options: InstallOptions) => installPlaybook(source, options));
}
