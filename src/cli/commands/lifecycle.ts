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
import pg from 'pg';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import { isPidWithin } from './process-tree.js';
import { classifyQueuePollerRogues } from '../../host/queue-poller-census.js';
import { dbosExecutorId } from '../../host/dbos-identity.js';
import { resolveDbosDbName } from '../../engine/ensure-postgres.js';
import { ensureHost, expectedGraphqlPort, isGraphqlHealthy } from '../../host/ensure-host.js';
import { runHostDaemon } from '../../host/daemon.js';
import {
  hostCodeVersion,
  isHostRunning,
  readHostRuntime,
  removeHostRuntime,
  type HostRuntimeState,
} from '../../host/host-runtime.js';
import type { RuntimeState } from '../config.js';

// Resolve lsof to a FIXED absolute path — never via $PATH (S4036: a writable PATH entry could shadow
// the binary). null if lsof isn't installed, in which case port-owner detection/reaping degrade to no-op.
const LSOF_PATH = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find((p) => existsSync(p)) ?? null;

/** PID listening on a local TCP port (via lsof), or null. Best-effort — null on any failure. */
function listenerPid(port: number): number | null {
  if (LSOF_PATH === null) return null;
  try {
    const out = execFileSync(LSOF_PATH, ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const pid = Number(out.split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no listener / lsof error
  }
}

/** The four ports a profile's stack uses (host GraphQL+MCP, standalone HTTP+Postgres), deduped. */
function profilePortList(host: HostRuntimeState | null, standalone: RuntimeState | null): number[] {
  const cfg = getConfig();
  const gql = host?.graphqlPort ?? expectedGraphqlPort();
  return [
    ...new Set([
      gql,
      host?.mcpPort ?? gql + 1,
      standalone?.httpPort ?? cfg.preferredPort,
      standalone?.pgPort ?? cfg.preferredPgPort,
    ]),
  ];
}

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
  const host = readHostRuntime();
  const standalone = readRuntime();
  const ports = profilePortList(host, standalone);
  let stopped = false;

  // Host first (it owns DBOS); then the standalone daemon underneath it.
  if (host && isAlive(host.pid)) {
    await stopProcess(host.pid);
    stopped = true;
  }
  removeHostRuntime();

  if (standalone && isAlive(standalone.pid)) {
    await stopProcess(standalone.pid);
    stopped = true;
  }
  removeRuntime();

  // Reap any orphan/duplicate still holding a profile port (slice 139) — a daemon/standalone NOT
  // tracked by host.json/runtime.json. Without this, `revo stop` leaves a zoo that can silently serve
  // runs off the shared DBOS queue.
  let reaped = 0;
  for (const port of ports) {
    const pid = listenerPid(port);
    if (pid !== null && isAlive(pid)) {
      await stopProcess(pid);
      reaped += 1;
    }
  }

  if (reaped > 0) console.log(`stopped (reaped ${reaped} orphan process${reaped === 1 ? '' : 'es'})`);
  else console.log(stopped ? 'stopped' : 'not running');
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

type QueuePollerRogue = { pid: number; executorId: string; applicationName: string };

/**
 * Census the profile's `dbos` database for FOREIGN DBOS queue pollers (slice 140) — a legacy/duplicate
 * daemon polling `dev-tasks` under an executor id that is not this profile's pinned owner. Connects to
 * the maintenance `postgres` db (pg_stat_activity is cluster-wide) and inspects `dbos_transact_%`
 * connections on the dbos db. Best-effort: returns `unavailable:true` when the DB is unreachable or the
 * role can't see other backends, so `doctor` warns rather than falsely reporting "clean".
 */
async function censusQueuePollers(
  profile: string,
  pgPort: number,
): Promise<{ rogues: QueuePollerRogue[]; unavailable: boolean }> {
  const client = new pg.Client(`postgresql://revisium:password@localhost:${pgPort}/postgres`);
  try {
    await client.connect();
    // Without privilege to see OTHER backends, pg_stat_activity hides their application_name → a silent
    // empty roster. Superuser OR pg_read_all_stats membership both suffice; anything less is reported as
    // "unavailable", never as "no rogues".
    const cap = await client.query(
      `SELECT (current_setting('is_superuser') = 'on'
               OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')) AS can_see`,
    );
    if (cap.rows[0]?.['can_see'] !== true) return { rogues: [], unavailable: true };
    const res = await client.query(
      `SELECT pid, application_name AS app, backend_start AS started
         FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'dbos_transact_%'`,
      [resolveDbosDbName()],
    );
    const rogues = classifyQueuePollerRogues(
      res.rows.map((r) => ({ pid: Number(r['pid']), applicationName: String(r['app']), backendStart: r['started'] })),
      dbosExecutorId(profile),
    ).map((r) => ({ pid: r.pid, executorId: r.executorId, applicationName: r.applicationName }));
    return { rogues, unavailable: false };
  } catch {
    return { rogues: [], unavailable: true };
  } finally {
    await client.end().catch(() => undefined);
  }
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

  // Detect untracked/duplicate daemons on the profile ports + a stale-version daemon (slice 139): a
  // listener whose pid isn't the tracked host/standalone is an orphan or a second daemon (the zoo).
  const gql = host?.graphqlPort ?? expectedGraphqlPort();
  const portChecks: Array<{ label: string; port: number; expected: number | null }> = [
    { label: 'GraphQL', port: gql, expected: host?.pid ?? null },
    { label: 'MCP', port: host?.mcpPort ?? gql + 1, expected: host?.pid ?? null },
    { label: 'standalone HTTP', port: standalone?.httpPort ?? getConfig().preferredPort, expected: standalone?.pid ?? null },
    { label: 'Postgres', port: standalone?.pgPort ?? getConfig().preferredPgPort, expected: standalone?.pid ?? null },
  ];
  const unexpectedPortOwners: Array<{ label: string; port: number; pid: number }> = [];
  for (const check of portChecks) {
    const pid = listenerPid(check.port);
    if (pid === null) continue;
    // Legitimate = the tracked pid ITSELF or one of its descendants. The standalone tier is a process
    // tree (launcher → HTTP-binding worker → embedded Postgres), so the actual port owner is usually a
    // child of the tracked launcher pid, not the launcher itself. Exact equality here mis-flagged the
    // healthy stack as a rogue daemon (dogfood, alpha.7). Only a listener OUTSIDE the tracked tree —
    // or any listener when nothing is tracked (expected === null) — is a real orphan/second daemon.
    const owned = check.expected !== null && isPidWithin(pid, new Set([check.expected]));
    if (!owned) {
      unexpectedPortOwners.push({ label: check.label, port: check.port, pid });
    }
  }
  const versionMismatch =
    host?.version !== undefined ? { running: host.version, current: hostCodeVersion() } : undefined;

  // Rogue queue-poller census — only when the standalone (and thus its Postgres) is alive; a foreign
  // executor connected to the dbos DB is a legacy/duplicate daemon the lock can't stop (slice 140).
  let queuePollerRogues: QueuePollerRogue[] | undefined;
  let rogueCensusUnavailable: boolean | undefined;
  if (standalone && standaloneAlive) {
    const census = await censusQueuePollers(profile, standalone.pgPort);
    queuePollerRogues = census.rogues;
    rogueCensusUnavailable = census.unavailable;
  }

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
    unexpectedPortOwners,
    versionMismatch,
    queuePollerRogues,
    rogueCensusUnavailable,
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
