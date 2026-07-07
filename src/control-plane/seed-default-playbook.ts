









import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { repoRoot } from '../config.js';
import type { PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { resolvePlaybookSource } from '../playbook/source-resolver.js';
import { readPlaybookManifest } from '../playbook/manifest.js';
import { loadPlaybookCatalogs } from '../playbook/catalog-loader.js';
import { mapPlaybookRows } from '../playbook/import-mapper.js';


export const DEFAULT_PLAYBOOK_ID = 'revisium-default';



export const DEFAULT_PLAYBOOK_SOURCE = join(repoRoot, 'control-plane', 'default-playbook');

export type SeedDefaultPlaybookResult =
  | { status: 'installed'; result: PlaybookInstallResult }
  | { status: 'already-installed' }
  | { status: 'raced' };




export type DefaultPlaybookInstaller = {
  listPlaybooks(): Promise<Array<{ id: string; version?: string; catalogHash?: string }>>;
  install(options: { source: string; name: string; commit: boolean }): Promise<PlaybookInstallResult>;
};





function isBenignInstallRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /revision is not a draft|nothing to commit|ROW_CONFLICT/i.test(message);
}





export function playbookCatalogHash(source: string, nameOverride = DEFAULT_PLAYBOOK_ID): string {
  const resolved = resolvePlaybookSource(source);
  const manifest = readPlaybookManifest(resolved.root);
  const catalogs = loadPlaybookCatalogs(resolved.root, manifest);
  return mapPlaybookRows({ root: resolved.root, source: resolved, manifest, catalogs, nameOverride }).catalogHash;
}

export function bundledCatalogHash(source: string): string {
  return playbookCatalogHash(source, DEFAULT_PLAYBOOK_ID);
}














export async function seedDefaultPlaybook(
  installer: DefaultPlaybookInstaller,
  source: string = DEFAULT_PLAYBOOK_SOURCE,
  log: (message: string) => void = () => {},
): Promise<SeedDefaultPlaybookResult> {
  if (!existsSync(source)) {
    throw new Error(`default playbook source not found: ${source}`);
  }
  const installed = await installer.listPlaybooks();
  const existing = installed.find((p) => p.id === DEFAULT_PLAYBOOK_ID);
  if (existing) {
    if (existing.catalogHash) {
      const currentHash = bundledCatalogHash(source);
      if (currentHash === existing.catalogHash) {
        log(`Default playbook ${DEFAULT_PLAYBOOK_ID} content unchanged (hash match) — skipping seed.`);
        return { status: 'already-installed' };
      }
      log(`Default playbook ${DEFAULT_PLAYBOOK_ID} content changed (hash mismatch) — re-seeding.`);
    } else {
      log(`Default playbook ${DEFAULT_PLAYBOOK_ID} has no catalog hash — re-seeding.`);
    }
  }
  try {
    const result = await installer.install({ source, name: DEFAULT_PLAYBOOK_ID, commit: true });
    return { status: 'installed', result };
  } catch (err) {
    if (isBenignInstallRace(err)) return { status: 'raced' };
    throw err;
  }
}




export async function seedDefaultPlaybookBestEffort(
  runSeed: () => Promise<SeedDefaultPlaybookResult>,
  log: (message: string) => void = (message) => console.error(message),
): Promise<void> {
  try {
    const outcome = await runSeed();
    if (outcome.status === 'installed') {
      const { result } = outcome;
      log(
        `Seeded default playbook ${result.playbookId} ` +
          `(${result.roles} roles, ${result.pipelines} pipelines, ${result.runProfiles} run profiles).`,
      );
    } else if (outcome.status === 'already-installed') {
      log('Default playbook already installed — skipping seed.');
    }
  } catch (err) {
    log(
      `Default playbook seed failed (schema bootstrap still applied): ${String(err)}. ` +
        'Re-run `revo start` to retry the default-playbook seed.',
    );
  }
}
