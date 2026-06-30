// One-time e2e setup: bring up the ISOLATED test daemon + control-plane ONCE before any e2e file
// runs (chained via `&&` in the `test:e2e` script). Runs as its own process and exits, so the test
// files boot fresh and see the committed playbook — avoiding the stale-head trap where a file that
// installs in its own `before` cannot resolve the just-installed playbook (its head scope was
// cached before the commit).
//
// Isolation: `test:e2e` sets REVO_DATA_DIR / REVO_PORT / REVO_PG_PORT / REVO_DBOS_DB so this whole
// chain (daemon spawn, bootstrap, DBOS) targets a throwaway home, never the dev dogfooding daemon.
// Run-events accumulate in the never-committed draft; past some size a filtered+ordered event query
// starts dropping the newest row (see memory: stale-draft). To keep the reused test home healthy we
// reset it once the run count crosses a threshold — fast reuse most runs, an occasional clean slate.
//
// Bootstrap + default-playbook seed run IN-PROCESS (the same path `revo start` uses on the daemon) —
// the `revo bootstrap`/`revo revisium` CLI commands were removed (ADR 0006: CLI is lifecycle-only).
import 'reflect-metadata';
import { rmSync } from 'node:fs';
import { ensureRevisium } from '../src/host/ensure-revisium.js';
import { bootstrapControlPlane } from '../src/control-plane/bootstrap.js';
import {
  playbookCatalogHash,
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../src/control-plane/seed-default-playbook.js';
import { createClientTransport } from '../src/control-plane/client-transport.js';
import { ControlPlaneError } from '../src/control-plane/errors.js';
import { getConfig, readRuntime, removeRuntime, isAlive } from '../src/config.js';
import { PlaybooksService } from '../src/revisium/playbooks.service.js';
import { PLAYBOOK_SOURCE } from '../src/e2e/kit/env.js';

const PLAYBOOK_ID = 'revisium-agent-playbook'; // matches scenarios.ts PLAYBOOK_ID
const RESET_AT_RUNS = 100; // reset the test home once it has accumulated this many runs (draft hygiene)

/** Bootstrapped? assertReady throws BOOTSTRAP_NOT_APPLIED on a fresh (un-bootstrapped) home. */
async function isBootstrapped(): Promise<boolean> {
  try {
    await createClientTransport('head').assertReady();
    return true;
  } catch (e) {
    if (e instanceof ControlPlaneError && e.code === 'BOOTSTRAP_NOT_APPLIED') return false;
    throw e;
  }
}

/** Count runs (cheap — one row per run; well below the event volume that degrades the draft query). */
async function runCount(): Promise<number> {
  try {
    const rows = await createClientTransport('draft').listRows('task_runs', { first: RESET_AT_RUNS + 1 });
    return rows.length;
  } catch {
    return 0; // not bootstrapped yet → nothing to count
  }
}

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
  await ensureRevisium(); // fresh spawn recreates the data dir + embedded Postgres
}

async function ensurePlaybook(): Promise<void> {
  const playbooks = new PlaybooksService(createClientTransport('head'));
  const installed = await playbooks.listPlaybooks();
  const existing = installed.find((p) => p.id === PLAYBOOK_ID);
  const expectedHash = playbookCatalogHash(PLAYBOOK_SOURCE, PLAYBOOK_ID);
  if (existing?.catalogHash === expectedHash) {
    console.log('[e2e setup] playbook already installed and current — skipping');
    return;
  }
  if (existing) {
    console.log('[e2e setup] playbook installed but stale or legacy — refreshing');
  }
  try {
    const r = await playbooks.install({ source: PLAYBOOK_SOURCE, name: PLAYBOOK_ID, commit: true });
    console.log(`[e2e setup] installed playbook ${r.playbookId} (${r.roles} roles, ${r.pipelines} pipelines)`);
  } catch (err) {
    if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
    console.log('[e2e setup] playbook install raced/duplicate — tolerated');
  }
}

async function main(): Promise<void> {
  if (process.env['REVO_E2E_REAL'] !== '1') return; // no-op unless the real e2e is requested
  console.log(`[e2e setup] data dir: ${getConfig().dataDir}`);
  await ensureRevisium(); // spawn the isolated test daemon if it is not already up

  if ((await isBootstrapped()) && (await runCount()) > RESET_AT_RUNS) {
    console.log(`[e2e setup] >${RESET_AT_RUNS} runs accumulated — resetting the test home for a clean draft`);
    await resetHome();
  }

  const rt = readRuntime();
  if (!rt) throw new Error('standalone runtime missing before bootstrap');
  console.log('[e2e setup] applying bootstrap schema/seed freshness');
  await bootstrapControlPlane(rt.httpPort);

  // Group M e2e relies on the built-in default. Run the same idempotent freshness check on every
  // e2e setup so reused homes pick up bundled catalog changes without requiring a full data-dir wipe.
  await seedDefaultPlaybookBestEffort(
    () => seedDefaultPlaybook(new PlaybooksService(createClientTransport('head'))),
    (message) => console.log(`[e2e setup] ${message}`),
  );

  await ensurePlaybook();
}

await main();
process.exit(0);
