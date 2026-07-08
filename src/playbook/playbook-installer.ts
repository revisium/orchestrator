import { loadPlaybookCatalogs } from './catalog-loader.js';
import { readPlaybookManifest } from './manifest.js';
import { mapPlaybookRows, type VersionedRow } from './import-mapper.js';
import { resolvePlaybookSource, type SourceResolverOptions } from './source-resolver.js';
import type { VersionedMeaningAccess, VersionedMeaningOperation } from '../control-plane/versioned-meaning.js';

export type PlaybookInstallOptions = {
  source: string;
  commit?: boolean;
  dryRun?: boolean;
  name?: string;
  version?: string;
};

export type PlaybookInstallResult = {
  playbookId: string;
  name: string;
  version: string;
  source: string;
  roles: number;
  pipelines: number;
  runProfiles: number;
  operations: VersionedMeaningOperation[];
  committed: boolean;
  dryRun: boolean;
  revisionId?: string;
};

export type PlaybookInstallerDeps = {
  access: VersionedMeaningAccess;
  sourceResolverOptions?: SourceResolverOptions;
};

export class PlaybookInstaller {
  constructor(private readonly deps: PlaybookInstallerDeps) {}

  async install(options: PlaybookInstallOptions): Promise<PlaybookInstallResult> {
    const source = resolvePlaybookSource(options.source, this.deps.sourceResolverOptions);
    const manifest = readPlaybookManifest(source.root);
    const catalogs = loadPlaybookCatalogs(source.root, manifest);
    const rows = mapPlaybookRows({
      root: source.root,
      source,
      manifest,
      catalogs,
      nameOverride: options.name,
      versionOverride: options.version,
    });

    const allRows: VersionedRow[] = [rows.playbook, ...rows.roles, ...rows.pipelines, ...rows.runProfiles];
    const updatedAt = typeof rows.playbook.data.updated_at === 'string'
      ? rows.playbook.data.updated_at
      : new Date().toISOString();
    const operations: VersionedMeaningOperation[] = options.dryRun
      ? allRows.map((row) => ({ action: 'dry-run', table: row.table, rowId: row.rowId }))
      : [];
    if (!options.dryRun) {
      for (const row of allRows) {
        operations.push(await this.deps.access.upsertRow(row));
      }
      for (const group of [
        { table: 'roles' as const, current: rows.roles },
        { table: 'pipelines' as const, current: rows.pipelines },
        { table: 'run_profiles' as const, current: rows.runProfiles },
      ]) {
        operations.push(...await this.deps.access.retireMissingRows({
          table: group.table,
          playbookId: rows.playbookId,
          keepRowIds: group.current.map((row) => row.rowId),
          retiredAt: updatedAt,
        }));
      }
    }

    let revisionId: string | undefined;
    if (options.commit && !options.dryRun) {
      const commitMessage = `Install playbook ${manifest.name}@${options.version ?? source.version}`;
      const revision = await this.deps.access.commit(commitMessage);
      revisionId = typeof revision?.id === 'string' ? revision.id : undefined;
    }

    return {
      playbookId: rows.playbookId,
      name: manifest.name,
      version: options.version ?? source.version,
      source: source.source,
      roles: rows.roles.length,
      pipelines: rows.pipelines.length,
      runProfiles: rows.runProfiles.length,
      operations,
      committed: Boolean(options.commit && !options.dryRun),
      dryRun: Boolean(options.dryRun),
      revisionId,
    };
  }
}
