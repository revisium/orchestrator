// One-time e2e setup: bring up the ISOLATED test host + control-plane ONCE before any e2e file
// runs (chained via `&&` in the `test:e2e` script). Runs as its own process and exits, so the test
// files boot fresh and see the committed playbook — avoiding the stale-head trap where a file that
// installs in its own `before` cannot resolve the just-installed playbook (its head scope was
// cached before the commit).
//
// Isolation: `test:e2e` sets REVO_DATA_DIR / REVO_PORT / REVO_PG_PORT so this whole chain
// (host daemon, embedded Postgres, bootstrap, DBOS) targets a throwaway home, never the dev
// dogfooding daemon.
//
// The test home is RESET (daemon stopped, data dir wiped, fresh spawn) on EVERY suite run, matching
// CI's always-cold start. Reuse was tried and is a trap twice over: run-events accumulate in the
// never-committed draft and past some size the filtered+ordered event query goes read-after-write
// stale (newest rows invisible for seconds — flaky event assertions), and a run-count reset
// heuristic fails silently. A reset costs ~10s; a degraded draft costs more in slower queries and
// nondeterminism.
//
import 'reflect-metadata';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EngineApiService } from '@revisium/engine';
import { bootstrapEngineControlPlane } from '../src/control-plane/bootstrap.js';
import {
  seedDefaultPlaybook,
  seedDefaultPlaybookBestEffort,
} from '../src/control-plane/seed-default-playbook.js';
import { getConfig, isAlive } from '../src/config.js';
import { ensureHost } from '../src/host/ensure-host.js';
import { readHostRuntime, removeHostRuntime } from '../src/host/host-runtime.js';
import { killTree, waitForExit } from '../src/cli/commands/revisium-helpers.js';
import { RevisiumModule } from '../src/revisium/revisium.module.js';
import { PlaybooksService } from '../src/revisium/playbooks.service.js';
import { RevoPrismaService } from '../src/storage/revo-prisma.service.js';
import { ensureStorage } from '../src/storage/ensure-storage.js';
import { PLAYBOOK_SOURCE } from '../src/e2e/kit/env.js';

const PLAYBOOK_ID = 'revisium-agent-playbook'; // matches scenarios.ts PLAYBOOK_ID
const CLI_ENTRY = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));

function readPostmasterPid(): number | null {
  try {
    const pid = Number(readFileSync(`${getConfig().dataDir}/pgdata/postmaster.pid`, 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stopPid(pid: number, timeoutMs = 20_000): Promise<void> {
  if (!isAlive(pid)) return;
  killTree(pid, 'SIGTERM');
  if (!(await waitForExit(pid, timeoutMs))) {
    killTree(pid, 'SIGKILL');
    await waitForExit(pid, 5_000);
  }
}

/** Stop the test host, wipe its data dir, and spawn a fresh host-owned embedded Postgres. */
async function resetHome(): Promise<void> {
  const host = readHostRuntime();
  if (host?.pid) await stopPid(host.pid);
  removeHostRuntime();

  const postmasterPid = readPostmasterPid();
  if (postmasterPid) await stopPid(postmasterPid);

  rmSync(getConfig().dataDir, { recursive: true, force: true });
  mkdirSync(getConfig().dataDir, { recursive: true });
  await ensureHost({ entry: CLI_ENTRY });
}

async function createControlPlaneContext(): Promise<INestApplicationContext> {
  await ensureStorage();
  return NestFactory.createApplicationContext(RevisiumModule, { logger: ['error', 'warn'] });
}

// Every playbook any e2e file needs is installed HERE, before the first test file runs, so head
// stays static for the whole suite. A mid-suite head commit invalidates other files' cached head
// scopes (the stale-head trap above) — harmless when files run one at a time, a race when they run
// in parallel. The in-file installs stay as skip-if-present guards.
const SUITE_PLAYBOOKS: { name: string; version?: string }[] = [
  { name: PLAYBOOK_ID },
  { name: 'revisium-agent-playbook-parallel-e2e', version: 'parallel-consensus-e2e' },
];

async function installPlaybooks(playbooks: PlaybooksService): Promise<void> {
  for (const { name, version } of SUITE_PLAYBOOKS) {
    try {
      const r = await playbooks.install({
        source: PLAYBOOK_SOURCE,
        name,
        ...(version ? { version } : {}),
        commit: true,
      });
      console.log(`[e2e setup] installed playbook ${r.playbookId} (${r.roles} roles, ${r.pipelines} pipelines)`);
    } catch (err) {
      if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
      console.log(`[e2e setup] playbook ${name} install raced/duplicate — tolerated`);
    }
  }
}

async function applyBootstrapAndDefaultSeed(): Promise<void> {
  console.log('[e2e setup] applying bootstrap schema/seed freshness');
  const ctx = await createControlPlaneContext();
  try {
    const engine = ctx.get(EngineApiService, { strict: false });
    const prisma = ctx.get(RevoPrismaService, { strict: false });
    const playbooks = ctx.get(PlaybooksService, { strict: false });
    await bootstrapEngineControlPlane(engine, prisma);
    await seedDefaultPlaybookBestEffort(
      () => seedDefaultPlaybook(playbooks),
      (message) => console.log(`[e2e setup] ${message}`),
    );
    await installPlaybooks(playbooks);
  } finally {
    await ctx.close();
  }
}

async function main(): Promise<void> {
  if (process.env['REVO_E2E_REAL'] !== '1') return; // no-op unless the real e2e is requested
  console.log(`[e2e setup] data dir: ${getConfig().dataDir}`);
  console.log('[e2e setup] resetting the test home (deterministic cold start, matches CI)');
  await resetHome();
  await applyBootstrapAndDefaultSeed();
}

await main();
process.exit(0);
