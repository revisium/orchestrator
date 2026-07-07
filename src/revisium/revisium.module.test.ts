/**
 * revisium.module.test.ts — 5.5 RevisiumModule compilation + provider resolution.
 *
 * Tests:
 *  - NestFactory.createApplicationContext(RevisiumModule) succeeds (host-free, no DBOS).
 *  - RolesService, RunService, InboxService, PlaybooksService resolve and are defined.
 *  - REVISIUM_TRANSPORT_DRAFT and REVISIUM_TRANSPORT_HEAD tokens resolve with correct mode.
 *  - Module construction makes NO network call (context creation succeeds without a live daemon).
 *  - Invariant #4 guard (§5.8): no source file or package manifest depends on @revisium/client.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..'); // agent-orchestrator/src/
const REPO_ROOT = join(SRC_DIR, '..');

function configureIsolatedStorageEnv(label: string): void {
  const suffix = `${process.pid}`;
  process.env['REVO_DATA_DIR'] = mkdtempSync(join(tmpdir(), `revo-${label}-${suffix}-`));
  process.env['REVO_PORT'] = String(28_000 + (process.pid % 1_000));
  process.env['REVO_PG_PORT'] = String(26_000 + (process.pid % 1_000));
  process.env['REVO_DB'] = `revo_${label}_${suffix}`;
  process.env['REVO_DBOS_DB'] = `dbos_${label}_${suffix}`;
}

// ─── Nest module application context test ─────────────────────

test('RevisiumModule creates an application context and provides all services without network call (edge 11)', async () => {
  configureIsolatedStorageEnv('module');
  const { ensureStorage, shutdownStorage } = await import('../storage/ensure-storage.js');
  await ensureStorage();

  // Lazy imports to avoid loading Nest at top-level.
  const { NestFactory } = await import('@nestjs/core');
  const { RevisiumModule } = await import('./revisium.module.js');
  const { RolesService } = await import('./roles.service.js');
  const { RunService } = await import('./run.service.js');
  const { InboxService } = await import('./inbox.service.js');
  const { PlaybooksService } = await import('./playbooks.service.js');
  const { REVISIUM_TRANSPORT_DRAFT, REVISIUM_TRANSPORT_HEAD } = await import('./tokens.js');

  const ctx = await NestFactory.createApplicationContext(RevisiumModule, { logger: false });

  try {
    // All three services must be resolvable and defined.
    const rolesService = ctx.get(RolesService);
    const runService = ctx.get(RunService);
    const inboxService = ctx.get(InboxService);
    const playbooksService = ctx.get(PlaybooksService);

    assert.ok(rolesService instanceof RolesService, 'RolesService must be injectable');
    assert.ok(runService instanceof RunService, 'RunService must be injectable');
    assert.ok(inboxService instanceof InboxService, 'InboxService must be injectable');
    assert.ok(playbooksService instanceof PlaybooksService, 'PlaybooksService must be injectable');

    // Transport tokens must resolve to objects with a `mode` property.
    const draftTransport = ctx.get<{ mode: string }>(REVISIUM_TRANSPORT_DRAFT);
    const headTransport = ctx.get<{ mode: string }>(REVISIUM_TRANSPORT_HEAD);
    assert.ok(draftTransport !== null && draftTransport !== undefined, 'draft transport token must resolve');
    assert.ok(headTransport !== null && headTransport !== undefined, 'head transport token must resolve');
    assert.equal(draftTransport.mode, 'draft');
    assert.equal(headTransport.mode, 'head');
  } finally {
    await ctx.close();
    await shutdownStorage();
  }
});

// ─── Invariant #4 guard (§5.8) ───────────────────────────────

function collectFiles(rootDir: string, include: (entry: string) => boolean): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (include(entry)) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
}

/**
 * Collect all *.ts files under rootDir, excluding *.test.ts files.
 * Uses readFileSync — no shell involved, no silent errors.
 */
function collectTsFiles(rootDir: string): string[] {
  return collectFiles(rootDir, (entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'));
}

/**
 * Regex that matches all import forms for a given bare module specifier:
 *   import ... from 'pkg'
 *   export ... from 'pkg'
 *   require('pkg')
 *   import('pkg')   (dynamic import)
 * Both single and double quotes.
 * Deliberately NOT wrapped in catch — if file IO fails, let it throw (C1 fix).
 */
function buildImportRegex(pkg: string): RegExp {
  // Escape special regex chars in the package name (handles @scope/name).
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:from|require|import)\\s*\\(?\\s*['"]${escaped}['"]`,
  );
}

/**
 * Find all non-test *.ts files under rootDir that contain an import/require/export
 * statement for the given package. Reads files with readFileSync — no shell, no
 * swallowed errors. Throws if any file cannot be read (not wrapped in catch).
 */
function findImporters(rootDir: string, pkg: string): string[] {
  const regex = buildImportRegex(pkg);
  return collectTsFiles(rootDir).filter((file) => {
    const src = readFileSync(file, 'utf8');
    return regex.test(src);
  });
}

test('Invariant #4: no source file imports @revisium/client generated SDK', () => {
  const allImporters = findImporters(SRC_DIR, '@revisium/client');
  assert.deepEqual(
    allImporters,
    [],
    `src/ must not import @revisium/client. Found violations:\n${allImporters.join('\n')}`,
  );
});

test('Invariant #4: package manifest does not depend on @revisium/client generated SDK', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.equal(
    manifest.dependencies?.['@revisium/client'],
    undefined,
    '@revisium/client must not be a runtime dependency',
  );
  assert.equal(
    manifest.devDependencies?.['@revisium/client'],
    undefined,
    '@revisium/client must not be a dev dependency',
  );
});

test('Invariant #4: agent guidance does not expose legacy standalone commands', () => {
  const forbidden = [
    /revo\s+revisium\b/i,
    /revo\s+bootstrap\b/i,
    /@revisium\/standalone\b/i,
    /runtime\.json\b/i,
    /Revisium HTTP/i,
    /standalone HTTP/i,
  ];
  const files = collectFiles(join(REPO_ROOT, '.agents'), (entry) => entry.endsWith('.md'));
  const violations: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (forbidden.some((pattern) => pattern.test(line))) {
        violations.push(`${file}:${index + 1}: ${line}`);
      }
    });
  }
  assert.deepEqual(
    violations,
    [],
    `Tracked .agents guidance must not expose legacy standalone commands:\n${violations.join('\n')}`,
  );
});
