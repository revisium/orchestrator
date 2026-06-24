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
import { resolvePlaybookSource } from '../playbook/source-resolver.js';
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
 * Minimal install surface — lets the seed be unit-tested without a live daemon. `version` is the
 * INSTALLED row's recorded version (carried on the playbook row, see import-mapper); optional so a
 * pre-version row (older install) reads as `undefined` and is treated as "older" (re-seed once).
 */
export type DefaultPlaybookInstaller = {
  listPlaybooks(): Promise<Array<{ id: string; version?: string }>>;
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
 * Install the built-in default playbook if it is not already present, OR re-install (overwrite) it when
 * the BUNDLED version is newer than the installed row's version. Returns a status discriminant so the
 * caller can log appropriately; never throws on a benign duplicate-install race.
 *
 * Version-aware re-seed (slice 144): a warm profile that merely already HAS the default playbook used to
 * skip unconditionally, so `npm i -g` a newer bundle + `revo restart` kept the OLD playbook. Now we read
 * the bundled version from the source package.json (the same value `resolvePlaybookSource` records on the
 * installed row) and compare it to the installed row's recorded version:
 *   - bundle NEWER  → re-seed (the installer upserts by row id, so the install path is the overwrite).
 *   - equal/older   → skip (idempotent; never downgrade).
 *   - installed row has NO version (pre-versioning install) → treat as older → re-seed once.
 * `install()` is the same upsert+commit path used for a fresh install, so re-seed stays idempotent.
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
    // The bundled version lives in the source package.json — resolve it the same way the installer does
    // so the comparison is against the exact value that lands on the row.
    const bundledVersion = resolvePlaybookSource(source).version;
    const installedVersion = existing.version ?? '';
    // A pre-versioning row (no recorded version) reads as "0.0.0" → strictly older → re-seed once so the
    // one-time upgrade lands; thereafter the versions match and we skip.
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
  listPlaybooks: () => Promise<Array<{ id: string; version?: string }>>,
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
