/**
 * revisium.module.test.ts — 5.5 RevisiumModule compilation + provider resolution.
 *
 * Tests:
 *  - NestFactory.createApplicationContext(RevisiumModule) succeeds (host-free, no DBOS).
 *  - RolesService, RunService, InboxService resolve and are defined.
 *  - REVISIUM_TRANSPORT_DRAFT and REVISIUM_TRANSPORT_HEAD tokens resolve with correct mode.
 *  - Module construction makes NO network call (context creation succeeds without a live daemon).
 *  - Invariant #4 guard (§5.8): (a) no src/cli/* imports @revisium/client;
 *    (b) meaning-layer importer set is the documented baseline + no new outside-layer importers;
 *    (c) build-context.ts is the named legacy exception.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..'); // agent-orchestrator/src/

// ─── Nest module standalone context test ─────────────────────

test('RevisiumModule creates a standalone context and provides all services without network call (edge 11)', async () => {
  // Lazy imports to avoid loading Nest at top-level.
  const { NestFactory } = await import('@nestjs/core');
  const { RevisiumModule } = await import('./revisium.module.js');
  const { RolesService } = await import('./roles.service.js');
  const { RunService } = await import('./run.service.js');
  const { InboxService } = await import('./inbox.service.js');
  const { REVISIUM_TRANSPORT_DRAFT, REVISIUM_TRANSPORT_HEAD } = await import('./tokens.js');

  const ctx = await NestFactory.createApplicationContext(RevisiumModule, { logger: false });

  try {
    // All three services must be resolvable and defined.
    const rolesService = ctx.get(RolesService);
    const runService = ctx.get(RunService);
    const inboxService = ctx.get(InboxService);

    assert.ok(rolesService instanceof RolesService, 'RolesService must be injectable');
    assert.ok(runService instanceof RunService, 'RunService must be injectable');
    assert.ok(inboxService instanceof InboxService, 'InboxService must be injectable');

    // Transport tokens must resolve to objects with a `mode` property.
    const draftTransport = ctx.get<{ mode: string }>(REVISIUM_TRANSPORT_DRAFT);
    const headTransport = ctx.get<{ mode: string }>(REVISIUM_TRANSPORT_HEAD);
    assert.ok(draftTransport !== null && draftTransport !== undefined, 'draft transport token must resolve');
    assert.ok(headTransport !== null && headTransport !== undefined, 'head transport token must resolve');
    assert.equal(draftTransport.mode, 'draft');
    assert.equal(headTransport.mode, 'head');
  } finally {
    await ctx.close();
  }
});

// ─── Invariant #4 guard (§5.8) ───────────────────────────────

/**
 * Collect all *.ts files under rootDir, excluding *.test.ts files.
 * Uses readFileSync — no shell involved, no silent errors.
 */
function collectTsFiles(rootDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        results.push(full);
      }
    }
  }
  walk(rootDir);
  return results;
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

/** Resolve to the repo src directory path. */
function srcPath(...parts: string[]): string {
  return join(SRC_DIR, ...parts);
}

/**
 * Documented baseline: the EXACT set of non-test .ts files under src/ that are
 * allowed to import @revisium/client (the control-plane/run layer) PLUS the named
 * legacy exception (src/worker/build-context.ts).
 *
 * If a future file is correctly added to the control-plane/run layer this test will
 * need updating — that is intentional: changes to the baseline require explicit review.
 */
const BASELINE_IMPORTERS = new Set([
  srcPath('control-plane', 'client-transport.ts'),
  srcPath('control-plane', 'data-access.ts'),
  srcPath('control-plane', 'steps.ts'),
  srcPath('run', 'inspect-run.ts'),
  // Named legacy exception (§3.9): worker loop, slated for deletion (ADR-0001).
  srcPath('worker', 'build-context.ts'),
]);

test('Invariant #4 (a): no src/cli/ file imports @revisium/client (CLI speaks verbs only)', () => {
  const cliDir = srcPath('cli');
  const matches = findImporters(cliDir, '@revisium/client');
  assert.deepEqual(
    matches,
    [],
    `src/cli/ must not import @revisium/client. Found violations:\n${matches.join('\n')}`,
  );
});

test('Invariant #4 (b): full-tree @revisium/client importer set equals the documented baseline', () => {
  const allImporters = findImporters(SRC_DIR, '@revisium/client');

  // Self-check: the matcher must find at least one known importer.
  // If findImporters silently no-ops (e.g. regex broken), this assertion will catch it.
  assert.ok(
    allImporters.includes(srcPath('control-plane', 'data-access.ts')),
    'Self-check failed: data-access.ts must be in the detected importer set; ' +
    'this means the import matcher is broken or the file was renamed',
  );

  // The importer set must be non-empty (guards against a silent no-op matcher).
  assert.ok(allImporters.length > 0, 'Importer set must be non-empty (matcher self-check)');

  // Sort both for stable comparison.
  const actual = [...allImporters].sort();
  const expected = [...BASELINE_IMPORTERS].sort();

  assert.deepEqual(
    actual,
    expected,
    `@revisium/client importer set differs from baseline.\n` +
    `New importers (not in baseline):\n` +
    `  ${actual.filter((f) => !BASELINE_IMPORTERS.has(f)).join('\n  ') || '(none)'}\n` +
    `Missing importers (in baseline but not found):\n` +
    `  ${expected.filter((f) => !allImporters.includes(f)).join('\n  ') || '(none)'}`,
  );
});

test('Invariant #4 (c): build-context.ts is the named legacy exception', () => {
  const buildContextPath = srcPath('worker', 'build-context.ts');
  const src = readFileSync(buildContextPath, 'utf8');
  // Verify it still imports @revisium/client (so the exception is still valid).
  assert.ok(
    src.includes('@revisium/client'),
    'build-context.ts should still import @revisium/client (it is the documented legacy exception)',
  );
  // The rationale is documented in TASK.md §3.9 and AGENTS.md (do not extend the legacy worker loop).
  assert.ok(true, 'build-context.ts acknowledged as legacy exception per §3.9');
});

test('Invariant #4 (b2): new service/module files do NOT import @revisium/client directly', () => {
  // RevisiumModule and service files must speak DataAccess/verbs, not @revisium/client.
  const revisiumDir = srcPath('revisium');
  const inboxVerbFile = srcPath('control-plane', 'inbox.ts');

  const revisiumImporters = findImporters(revisiumDir, '@revisium/client');
  assert.deepEqual(
    revisiumImporters,
    [],
    `src/revisium/ must not import @revisium/client directly:\n${revisiumImporters.join('\n')}`,
  );

  const inboxVerbSrc = readFileSync(inboxVerbFile, 'utf8');
  assert.ok(
    !inboxVerbSrc.includes('@revisium/client'),
    'src/control-plane/inbox.ts must not import @revisium/client',
  );
});
