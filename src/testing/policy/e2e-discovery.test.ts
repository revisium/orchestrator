import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverE2eTests } from './e2e-discovery.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function independentlyListE2eTests(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return independentlyListE2eTests(path);
    if (!entry.isFile() || !entry.name.endsWith('.e2e.test.ts')) return [];
    return [relative(repositoryRoot, path).split(sep).join('/')];
  });
}

test('E2E discovery includes every nested suite exactly once', () => {
  const expected = independentlyListE2eTests(resolve(repositoryRoot, 'src/e2e'))
    .sort((left, right) => left.localeCompare(right));
  const actual = discoverE2eTests();

  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
  assert.ok(actual.every((path) => path.split('/').length > 3), 'all E2E suites live in an owning subdirectory');
});

test('the real E2E command uses recursive discovery and preserves execution bounds', () => {
  const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const command = pkg.scripts['test:e2e'] ?? '';

  assert.match(command, /tsx scripts\/discover-e2e-tests\.ts/);
  assert.match(command, /--test-concurrency=\$\{REVO_E2E_FILE_CONCURRENCY:-4\}/);
  assert.match(command, /--test-force-exit/);
  assert.match(command, /REVO_SHUTDOWN_DRAIN_TIMEOUT_MS=100/);
  assert.match(command, /REVO_DEV_TASKS_POLL_INTERVAL_MS=25/);

  const ci = readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /REVO_E2E_FILE_CONCURRENCY:\s*2/);
});
