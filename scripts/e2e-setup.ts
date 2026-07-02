// One-time e2e setup: bring up the ISOLATED test daemon + control-plane ONCE before any e2e file
// runs (chained via `&&` in the `test:e2e` script). Runs as its own process and exits, so the test
// files boot fresh and see the committed playbook — avoiding the stale-head trap where a file that
// installs in its own `before` cannot resolve the just-installed playbook (its head scope was
// cached before the commit).
//
// Isolation: `test:e2e` sets REVO_DATA_DIR / REVO_PORT / REVO_PG_PORT / REVO_DBOS_DB so this whole
// chain (daemon spawn, bootstrap, DBOS) targets a throwaway home, never the dev dogfooding daemon.
//
// The test home is RESET (daemon stopped, data dir wiped, fresh spawn) on EVERY suite run, matching
// CI's always-cold start. Reuse was tried and is a trap twice over: run-events accumulate in the
// never-committed draft and past some size the filtered+ordered event query goes read-after-write
// stale (newest rows invisible for seconds — flaky event assertions), and a run-count reset
// heuristic fails silently. A reset costs ~10s; a degraded draft costs more in slower queries and
// nondeterminism.
//
// Bootstrap + default-playbook seed run IN-PROCESS (the same path `revo start` uses on the daemon) —
// the `revo bootstrap`/`revo revisium` CLI commands were removed (ADR 0006: CLI is lifecycle-only).
import 'reflect-metadata';
import { mkdirSync, rmSync } from 'node:fs';
import { ensureRevisium } from '../src/host/ensure-revisium.js';
import { bootstrapControlPlane } from '../src/control-plane/bootstrap.js';
import {
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../src/control-plane/seed-default-playbook.js';
import { createClientTransport } from '../src/control-plane/client-transport.js';
import { getConfig, readRuntime, removeRuntime, isAlive } from '../src/config.js';
import { PlaybooksService } from '../src/revisium/playbooks.service.js';
import { PLAYBOOK_SOURCE } from '../src/e2e/kit/env.js';

const PLAYBOOK_ID = 'revisium-agent-playbook'; // matches scenarios.ts PLAYBOOK_ID

/** Stop the test daemon, wipe its data dir, and spawn a fresh one (clean draft). */
async function resetHome(): Promise<void> {
  const rt = readRuntime();
  if (rt?.pid) {
    // Stop the test daemon and WAIT for it to exit before wiping — process.kill is async, so deleting
    // pgdata out from under a live embedded Postgres races shutdown (port/file contention, flaky e2e).
    try {
      if (isAlive(rt.pid)) process.kill(rt.pid, 'SIGTERM');
    } catch (err) {
      if ((err as { code?: string }).code !== 'ESRCH') throw err; // already gone — fine
    }
    const deadline = Date.now() + 5_000;
    while (isAlive(rt.pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(rt.pid)) process.kill(rt.pid, 'SIGKILL');
  }
  removeRuntime();
  rmSync(getConfig().dataDir, { recursive: true, force: true });
  mkdirSync(getConfig().dataDir, { recursive: true });
  await ensureRevisium(); // fresh spawn recreates the data dir + embedded Postgres
}

async function installPlaybook(): Promise<void> {
  const playbooks = new PlaybooksService(createClientTransport('head'));
  try {
    const r = await playbooks.install({ source: PLAYBOOK_SOURCE, name: PLAYBOOK_ID, commit: true });
    console.log(`[e2e setup] installed playbook ${r.playbookId} (${r.roles} roles, ${r.pipelines} pipelines)`);
  } catch (err) {
    if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
    console.log('[e2e setup] playbook install raced/duplicate — tolerated');
  }
}

async function applyBootstrapAndDefaultSeed(): Promise<void> {
  const rt = readRuntime();
  if (!rt) throw new Error('standalone runtime missing before bootstrap');
  console.log('[e2e setup] applying bootstrap schema/seed freshness');
  await bootstrapControlPlane(rt.httpPort);

  await seedDefaultPlaybookBestEffort(
    () => seedDefaultPlaybook(new PlaybooksService(createClientTransport('head'))),
    (message) => console.log(`[e2e setup] ${message}`),
  );
}

async function main(): Promise<void> {
  if (process.env['REVO_E2E_REAL'] !== '1') return; // no-op unless the real e2e is requested
  console.log(`[e2e setup] data dir: ${getConfig().dataDir}`);
  console.log('[e2e setup] resetting the test home (deterministic cold start, matches CI)');
  await resetHome();
  await applyBootstrapAndDefaultSeed();
  await installPlaybook();
}

await main();
process.exit(0);
