/**
 * seed-default-playbook.ts — install the BUILT-IN DEFAULT playbook during `revo bootstrap` (slice 5,
 * plan 0015).
 *
 * The default is DATA, not engine code: a committed playbook source under
 * `control-plane/default-playbook/` (manifest + roles/pipelines catalogs carrying data-driven
 * `template_json`). `revo bootstrap` seeds the control-plane SCHEMA (bootstrap.config.json), then this
 * installs the default playbook so a FRESH control-plane has a working `feature-development` +
 * `local-change` pipeline out-of-the-box — without depending on the external agent-playbook repo.
 *
 * Idempotent: skips when the default playbook is already installed (so re-running bootstrap is a
 * no-op), and tolerates a benign concurrent/duplicate commit ("revision is not a draft").
 */
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { repoRoot } from '../config.js';
import { PlaybookInstaller, type PlaybookInstallResult } from '../playbook/playbook-installer.js';
import { createVersionedMeaningAccess } from './versioned-meaning.js';

/** Installed row id of the built-in default playbook (distinct from the e2e fixture playbook). */
export const DEFAULT_PLAYBOOK_ID = 'revisium-default';

/**
 * Source directory of the committed default playbook. Packaged at the repo/package root (see the
 * package `files` allowlist) so the SHIPPED `revo bootstrap` (running from dist/) resolves it.
 */
export const DEFAULT_PLAYBOOK_SOURCE = join(repoRoot, 'control-plane', 'default-playbook');

export type SeedDefaultPlaybookResult =
  | { status: 'installed'; result: PlaybookInstallResult }
  | { status: 'already-installed' }
  | { status: 'raced' };

/** Minimal install surface — lets the seed be unit-tested without a live daemon. */
export type DefaultPlaybookInstaller = {
  listPlaybooks(): Promise<Array<{ id: string }>>;
  install(options: { source: string; name: string; commit: boolean }): Promise<PlaybookInstallResult>;
};

/**
 * True for a benign "already committed / nothing to do" race during a concurrent bootstrap. Matched
 * narrowly against the explicit duplicate-commit signals (Revisium draft commit + control-plane
 * ROW_CONFLICT) — a generic `already` substring would misclassify unrelated installer failures as a
 * race and silently swallow them.
 */
function isBenignInstallRace(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /revision is not a draft|nothing to commit|ROW_CONFLICT/i.test(message);
}

/**
 * Install the built-in default playbook if it is not already present. Returns a status discriminant
 * so the caller can log appropriately; never throws on a benign duplicate-install race.
 */
export async function seedDefaultPlaybook(
  installer: DefaultPlaybookInstaller,
  source: string = DEFAULT_PLAYBOOK_SOURCE,
): Promise<SeedDefaultPlaybookResult> {
  // `listPlaybooks` is the accurate presence signal: bootstrap seeds role/profile rows but NOT a
  // playbook record, so this is empty until the default playbook is installed.
  const installed = await installer.listPlaybooks();
  if (installed.some((p) => p.id === DEFAULT_PLAYBOOK_ID)) {
    return { status: 'already-installed' };
  }
  if (!existsSync(source)) {
    throw new Error(`default playbook source not found: ${source}`);
  }
  try {
    const result = await installer.install({ source, name: DEFAULT_PLAYBOOK_ID, commit: true });
    return { status: 'installed', result };
  } catch (err) {
    if (isBenignInstallRace(err)) return { status: 'raced' };
    throw err;
  }
}

/**
 * Default-daemon installer adapter used by `revo bootstrap`: a minimal {@link DefaultPlaybookInstaller}
 * backed by the live draft scope (the same versioned-meaning access the `revo playbook install` CLI
 * uses). Reads the installed playbooks list from HEAD via the provided reader.
 */
export function createDaemonInstaller(
  listPlaybooks: () => Promise<Array<{ id: string }>>,
): DefaultPlaybookInstaller {
  return {
    listPlaybooks,
    install: (options) =>
      new PlaybookInstaller({ access: createVersionedMeaningAccess({}) }).install(options),
  };
}

/**
 * Run {@link seedDefaultPlaybook} as a BEST-EFFORT step: report the outcome but never throw. The
 * schema is the critical bootstrap artifact; a playbook-seed failure must not fail stack bring-up
 * (it is logged so the operator can re-run the install). `runSeed`/`log` are injected so the logging
 * policy is unit-testable without a live daemon.
 */
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
          `(${result.roles} roles, ${result.pipelines} pipelines).`,
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
