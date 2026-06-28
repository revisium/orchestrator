/**
 * seed-default-playbook.ts — install the BUILT-IN DEFAULT playbook during `revo bootstrap`.
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
import { resolvePlaybookSource } from '../playbook/source-resolver.js';
import { readPlaybookManifest } from '../playbook/manifest.js';
import { loadPlaybookCatalogs } from '../playbook/catalog-loader.js';
import { mapPlaybookRows } from '../playbook/import-mapper.js';
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

/**
 * Minimal install surface — lets the seed be unit-tested without a live daemon. `version` and
 * `catalogHash` are INSTALLED row data (see import-mapper); both optional so legacy rows (pre-B1
 * installs) fall through to the version-compare fallback path without a schema migration.
 */
export type DefaultPlaybookInstaller = {
  listPlaybooks(): Promise<Array<{ id: string; version?: string; catalogHash?: string }>>;
  install(options: { source: string; name: string; commit: boolean }): Promise<PlaybookInstallResult>;
};

/**
 * Compare two `x.y.z` semver strings numerically: returns >0 when `a` is newer, <0 when older, 0 when
 * equal. Missing/non-numeric components read as 0 (so `0.1` == `0.1.0`). We hand-roll this rather than
 * pull in a `semver` dependency: the default playbook only ever carries simple dotted release versions,
 * and an unparsable component degrades to "older" via the missing-version path in the caller.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

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
 * Recompute the content fingerprint for the bundled default playbook at `source`. Exported so tests
 * can compute the expected hash without a live daemon and pin the "identical content → skip" case.
 * Uses the exact same path as the installer (mapPlaybookRows with nameOverride) so the two hashes
 * are always in sync.
 */
export function bundledCatalogHash(source: string): string {
  const resolved = resolvePlaybookSource(source);
  const manifest = readPlaybookManifest(resolved.root);
  const catalogs = loadPlaybookCatalogs(resolved.root, manifest);
  return mapPlaybookRows({ root: resolved.root, source: resolved, manifest, catalogs, nameOverride: DEFAULT_PLAYBOOK_ID }).catalogHash;
}

/**
 * Install the built-in default playbook if it is not already present, OR re-install (overwrite) it
 * when the bundled content has changed. Returns a status discriminant so the caller can log
 * appropriately; never throws on a benign duplicate-install race.
 *
 * Decision priority (B1 content-hash re-seed):
 *   1. catalogHash present on installed row → compare to bundledCatalogHash(source):
 *      - match   → skip (content unchanged, any version).
 *      - differ  → re-seed (the installer upserts by row id).
 *   2. no catalogHash (legacy row predating B1) → fall back to version compare:
 *      - bundle NEWER  → re-seed.
 *      - equal/older   → skip (never downgrade).
 *      - no version    → treat as "0.0.0" → re-seed once so the one-time upgrade lands.
 * `install()` is the same upsert+commit path used for a fresh install, so re-seed is idempotent.
 */
export async function seedDefaultPlaybook(
  installer: DefaultPlaybookInstaller,
  source: string = DEFAULT_PLAYBOOK_SOURCE,
  log: (message: string) => void = () => {},
): Promise<SeedDefaultPlaybookResult> {
  if (!existsSync(source)) {
    throw new Error(`default playbook source not found: ${source}`);
  }
  // `listPlaybooks` is the accurate presence signal: bootstrap seeds role/profile rows but NOT a
  // playbook record, so this is empty until the default playbook is installed.
  const installed = await installer.listPlaybooks();
  const existing = installed.find((p) => p.id === DEFAULT_PLAYBOOK_ID);
  if (existing) {
    if (existing.catalogHash) {
      // Content-hash path (B1): detects any change — catalog records, pipelines, or prompt bodies —
      // without requiring a manual version bump.
      const currentHash = bundledCatalogHash(source);
      if (currentHash === existing.catalogHash) {
        log(`Default playbook ${DEFAULT_PLAYBOOK_ID} content unchanged (hash match) — skipping seed.`);
        return { status: 'already-installed' };
      }
      log(`Default playbook ${DEFAULT_PLAYBOOK_ID} content changed (hash mismatch) — re-seeding.`);
    } else {
      // Legacy fallback: row predates the B1 content-hash signal; compare by version so pre-B1
      // installs still get re-seeded when the bundle version advances.
      const bundledVersion = resolvePlaybookSource(source).version;
      const installedVersion = existing.version ?? '';
      const comparison = compareSemver(bundledVersion, installedVersion || '0.0.0');
      if (comparison <= 0) {
        log(
          `Default playbook ${DEFAULT_PLAYBOOK_ID} up to date ` +
            `(installed ${installedVersion || '(none)'} >= bundled ${bundledVersion}) — skipping seed.`,
        );
        return { status: 'already-installed' };
      }
      log(
        `Default playbook ${DEFAULT_PLAYBOOK_ID} bundle is newer ` +
          `(installed ${installedVersion || '(none)'} -> bundled ${bundledVersion}) — re-seeding.`,
      );
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

/**
 * Default-daemon installer adapter used by `revo bootstrap`: a minimal {@link DefaultPlaybookInstaller}
 * backed by the live draft scope (the same versioned-meaning access the `revo playbook install` CLI
 * uses). Reads the installed playbooks list from HEAD via the provided reader.
 */
export function createDaemonInstaller(
  listPlaybooks: () => Promise<Array<{ id: string; version?: string; catalogHash?: string }>>,
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
