/**
 * Lifecycle commands — the public face of Revo as one daemonized product (ADR 0006):
 *   revo start / stop / status   (+ doctor/logs/restart land alongside)
 *
 * These manage the WHOLE stack: the Revo host daemon (single DBOS owner, serves GraphQL/MCP) and,
 * underneath it, the standalone Revisium daemon. They are pure process managers — they never build
 * an AppModule or launch DBOS themselves (only the daemon does). The hidden `__daemon` command is
 * the detached daemon entrypoint that `ensureHost` spawns.
 */
import { Command } from 'commander';
import {
  baseUrl,
  getConfig,
  isAlive,
  isHealthy,
  readRuntime,
  removeRuntime,
} from '../config.js';
import { killTree, waitForExit } from './revisium-helpers.js';
import { ensureHost, expectedGraphqlPort, isGraphqlHealthy } from '../../host/ensure-host.js';
import { runHostDaemon } from '../../host/daemon.js';
import { isHostRunning, readHostRuntime, removeHostRuntime } from '../../host/host-runtime.js';

type ProfileOptions = { profile?: string };

/** A --profile flag sets REVO_PROFILE so the resolved profile flows to the daemon child via env. */
function applyProfileEnv(options: ProfileOptions): void {
  if (options.profile) process.env['REVO_PROFILE'] = options.profile;
}

/** `revo start` — bring up the whole stack (host daemon + standalone) and print its endpoints. */
async function startStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  const { profile, dataDir } = getConfig();
  try {
    const { runtime, alreadyRunning } = await ensureHost();
    const standalone = readRuntime();
    console.log(alreadyRunning ? `Revo already running (profile ${profile})` : `Revo started (profile ${profile})`);
    console.log(`Host daemon: pid ${runtime.pid}`);
    console.log(`GraphQL: ${baseUrl(runtime.graphqlPort)}/graphql`);
    if (standalone) console.log(`Revisium: ${baseUrl(standalone.httpPort)} (pg ${standalone.pgPort})`);
    console.log(`Data dir: ${dataDir}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** Stop a pid gracefully: SIGTERM, then SIGKILL if it has not exited within the grace period. */
async function stopProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  killTree(pid, 'SIGTERM');
  if (!(await waitForExit(pid, 20_000))) {
    killTree(pid, 'SIGKILL');
    await waitForExit(pid, 5_000);
  }
}

/** `revo stop` — stop the host daemon first (it owns DBOS), then the standalone Revisium daemon. */
async function stopStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  let stopped = false;

  // Host first (it owns DBOS); then the standalone daemon underneath it.
  const host = readHostRuntime();
  if (host && isAlive(host.pid)) {
    await stopProcess(host.pid);
    stopped = true;
  }
  removeHostRuntime();

  const standalone = readRuntime();
  if (standalone && isAlive(standalone.pid)) {
    await stopProcess(standalone.pid);
    stopped = true;
  }
  removeRuntime();

  console.log(stopped ? 'stopped' : 'not running');
}

/** `revo status` — summarize the stack: profile, data dir, host daemon, and Revisium health. */
async function statusStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  const { profile, dataDir } = getConfig();
  console.log(`Profile: ${profile}`);
  console.log(`Data dir: ${dataDir}`);

  const host = readHostRuntime();
  if (host && isHostRunning()) {
    const healthy = await isGraphqlHealthy(host.graphqlPort);
    console.log(`Host daemon: running (pid ${host.pid}) — GraphQL ${baseUrl(host.graphqlPort)}/graphql ${healthy ? 'OK' : 'FAILING'}`);
  } else {
    console.log(`Host daemon: stopped (GraphQL port ${expectedGraphqlPort()})`);
  }

  const standalone = readRuntime();
  if (standalone && isAlive(standalone.pid)) {
    const healthy = await isHealthy(standalone.httpPort);
    console.log(`Revisium: running (pid ${standalone.pid}) on ${baseUrl(standalone.httpPort)} pg ${standalone.pgPort} — health ${healthy ? 'OK' : 'FAILING'}`);
  } else {
    console.log('Revisium: stopped');
  }
}

/** Register the lifecycle commands (start/stop/status) + the hidden `__daemon` entrypoint. */
export function registerLifecycle(program: Command): void {
  program
    .command('start')
    .description('Start the Revo stack (host daemon + standalone Revisium)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .action((options: ProfileOptions) => startStack(options));

  program
    .command('stop')
    .description('Stop the Revo stack (host daemon first, then standalone)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .action((options: ProfileOptions) => stopStack(options));

  program
    .command('status')
    .description('Show Revo stack status (host daemon, Revisium, profile)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .action((options: ProfileOptions) => statusStack(options));

  // Internal: the detached daemon entrypoint spawned by ensureHost (not a user-facing command).
  program
    .command('__daemon', { hidden: true })
    .description('Run the host daemon in the foreground (internal — spawned by `revo start`)')
    .action(() => runHostDaemon());
}
