/**
 * Unit tests for the LOGGING POLICY of `seedDefaultPlaybookBestEffort` — the branch that maps each
 * seed outcome (installed / already-installed / raced / thrown) to operator-facing stderr — without a
 * live daemon. `runSeed`/`log` are injected. The daemon-backed call-site is exercised by the
 * seed-default-playbook e2e and the `revo start` real-app run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDefaultPlaybookBestEffort, type SeedDefaultPlaybookResult } from './seed-default-playbook.js';
import type { PlaybookInstallResult } from '../playbook/playbook-installer.js';

const INSTALL_RESULT: PlaybookInstallResult = {
  playbookId: 'revisium-default',
  name: 'Revisium Default Playbook',
  version: '0.1.0',
  source: 'local:default',
  roles: 6,
  pipelines: 2,
  operations: [],
  committed: true,
  dryRun: false,
};

/** Collect the messages a run would print so we can assert on the logging policy. */
function capture() {
  const lines: string[] = [];
  return { log: (m: string) => lines.push(m), lines };
}

test('seedDefaultPlaybookBestEffort: logs an install summary on a fresh install', async () => {
  const out = capture();
  const outcome: SeedDefaultPlaybookResult = { status: 'installed', result: INSTALL_RESULT };
  await seedDefaultPlaybookBestEffort(async () => outcome, out.log);
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /Seeded default playbook revisium-default \(6 roles, 2 pipelines\)\./);
});

test('seedDefaultPlaybookBestEffort: logs a skip when the playbook is already installed', async () => {
  const out = capture();
  await seedDefaultPlaybookBestEffort(async () => ({ status: 'already-installed' }), out.log);
  assert.deepEqual(out.lines, ['Default playbook already installed — skipping seed.']);
});

test('seedDefaultPlaybookBestEffort: stays silent on a benign concurrent-commit race', async () => {
  const out = capture();
  await seedDefaultPlaybookBestEffort(async () => ({ status: 'raced' }), out.log);
  assert.deepEqual(out.lines, [], 'a raced seed is a no-op — nothing to report');
});

test('seedDefaultPlaybookBestEffort: reports a seed failure WITHOUT throwing (best-effort)', async () => {
  const out = capture();
  await assert.doesNotReject(() =>
    seedDefaultPlaybookBestEffort(async () => {
      throw new Error('PLAYBOOK_INVALID_CATALOG: boom');
    }, out.log),
  );
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0], /seed failed \(schema bootstrap still applied\): .*PLAYBOOK_INVALID_CATALOG/);
  assert.match(out.lines[0], /revo playbook install/);
});
