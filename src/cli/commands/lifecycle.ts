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
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import {
  baseUrl,
  getConfig,
  isAlive,
  isHealthy,
  readRuntime,
  removeRuntime,
} from '../config.js';
import { killTree, tailLines, waitForExit } from './revisium-helpers.js';
import { buildDoctorReport } from './doctor-report.js';
import { ensureHost, expectedGraphqlPort, isGraphqlHealthy } from '../../host/ensure-host.js';
import { runHostDaemon } from '../../host/daemon.js';
import { isHostRunning, readHostRuntime, removeHostRuntime } from '../../host/host-runtime.js';

const DEFAULT_LOG_LINES = 50;

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

/** `revo restart` — stop then start the whole stack (same profile). The dev code-reload primitive. */
async function restartStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  console.log('Restarting Revo stack…');
  await stopStack(options);
  await startStack(options);
}

/** `revo doctor` — diagnose the stack as a pure client: process/port/profile/stale-file health. */
async function doctorStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  const { profile, dataDir } = getConfig();

  const host = readHostRuntime();
  const hostAlive = host !== null && isAlive(host.pid);
  const hostHealthy = host !== null && hostAlive && (await isGraphqlHealthy(host.graphqlPort));

  const standalone = readRuntime();
  const standaloneAlive = standalone !== null && isAlive(standalone.pid);
  const standaloneHealthy = standalone !== null && standaloneAlive && (await isHealthy(standalone.httpPort));

  const report = buildDoctorReport({
    host: {
      present: host !== null,
      alive: hostAlive,
      healthy: hostHealthy,
      pid: host?.pid ?? null,
      port: host?.graphqlPort ?? null,
    },
    standalone: {
      present: standalone !== null,
      alive: standaloneAlive,
      healthy: standaloneHealthy,
      pid: standalone?.pid ?? null,
      port: standalone?.httpPort ?? null,
    },
  });

  console.log(`Profile: ${profile}`);
  console.log(`Data dir: ${dataDir}`);
  if (report.ok) {
    console.log('OK — stack is healthy.');
    return;
  }
  for (const issue of report.issues) console.log(`✗ ${issue}`);
  process.exitCode = 1;
}

type LogsOptions = ProfileOptions & { lines?: string; follow?: boolean };
type LogTarget = { label: string; file: string };

/** Resolve which logs to read: `host`, `standalone`, or both (default). Profile-scoped paths. */
function resolveLogTargets(target: string | undefined): LogTarget[] {
  const { logFile, hostLogFile } = getConfig();
  const host: LogTarget = { label: 'host', file: hostLogFile };
  const standalone: LogTarget = { label: 'standalone', file: logFile };
  if (target === 'host') return [host];
  if (target === 'standalone') return [standalone];
  return [host, standalone];
}

/** `revo logs [target]` — print the tail of the daemon logs; a pure file read (works when down). */
async function logsStack(target: string | undefined, options: LogsOptions): Promise<void> {
  applyProfileEnv(options);
  if (target !== undefined && target !== 'host' && target !== 'standalone') {
    console.error(`Invalid logs target "${target}". Use "host" or "standalone".`);
    process.exitCode = 1;
    return;
  }
  const requested = Number(options.lines ?? DEFAULT_LOG_LINES);
  const lines = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_LOG_LINES;
  const targets = resolveLogTargets(target);

  for (const { label, file } of targets) {
    const tail = tailLines(file, lines);
    console.log(`==> [${label}] ${file} <==`);
    console.log(tail === '' ? '(no log yet)' : tail);
    console.log('');
  }

  if (options.follow) await followLogs(targets);
}

/**
 * Follow mode: poll each log for bytes appended past a tracked offset and stream them, labelled,
 * until interrupted (Ctrl-C). The daemons open their logs append-only (no rotation), so a byte
 * offset is a stable cursor; a shrink (manual truncate) simply resyncs to the new end.
 */
async function followLogs(targets: LogTarget[]): Promise<void> {
  const offsets = new Map<string, number>();
  for (const { file } of targets) offsets.set(file, existsSync(file) ? statSync(file).size : 0);

  for (;;) {
    for (const { label, file } of targets) {
      if (!existsSync(file)) continue;
      const size = statSync(file).size;
      const from = offsets.get(file) ?? 0;
      if (size > from) {
        const fd = openSync(file, 'r');
        try {
          const buf = Buffer.alloc(size - from);
          readSync(fd, buf, 0, buf.length, from);
          process.stdout.write(prefixLines(label, buf.toString('utf8')));
        } finally {
          closeSync(fd);
        }
      }
      offsets.set(file, size);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Prefix each non-empty line of a streamed chunk with its tier label for interleaved follow output. */
function prefixLines(label: string, chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => (line === '' ? line : `[${label}] ${line}`))
    .join('\n');
}

/** Register the lifecycle commands (start/stop/status/restart/doctor/logs) + the hidden `__daemon` entrypoint. */
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

  program
    .command('restart')
    .description('Restart the Revo stack (stop, then start)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .action((options: ProfileOptions) => restartStack(options));

  program
    .command('doctor')
    .description('Diagnose the Revo stack (process/port/profile health)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .action((options: ProfileOptions) => doctorStack(options));

  program
    .command('logs [target]')
    .description('Tail Revo logs (target: host | standalone; default both)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .option('-n, --lines <count>', 'Lines to show from the end', String(DEFAULT_LOG_LINES))
    .option('-f, --follow', 'Stream new log output until interrupted')
    .action((target: string | undefined, options: LogsOptions) => logsStack(target, options));

  // Internal: the detached daemon entrypoint spawned by ensureHost (not a user-facing command).
  program
    .command('__daemon', { hidden: true })
    .description('Run the host daemon in the foreground (internal — spawned by `revo start`)')
    .action(() => runHostDaemon());
}
