






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
import { isPidWithin, listProcesses, parentPid, processStartTime } from './process-tree.js';
import {
  classifyRevoProcess,
  evictByTermination,
  selectReapTargets,
  type EvictionOutcome,
  type RevoProc,
} from './rogue-reaper.js';
import { classifyQueuePollerRogues } from '../../host/queue-poller-census.js';
import { dbosExecutorId } from '../../host/dbos-identity.js';
import { resolveDbosDbName } from '../../engine/ensure-postgres.js';
import { ensureHost, expectedGraphqlPort, isGraphqlHealthy } from '../../host/ensure-host.js';
import { runHostDaemon } from '../../host/daemon.js';
import {
  allTrackedHostPids,
  hostCodeVersion,
  isHostRunning,
  readHostRuntime,
  removeHostRuntime,
  type HostRuntimeState,
} from '../../host/host-runtime.js';
import type { RuntimeState } from '../config.js';

const LSOF_PATH = ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof'].find((p) => existsSync(p)) ?? null;


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
    return null;
  }
}


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


function applyProfileEnv(options: ProfileOptions): void {
  if (options.profile) process.env['REVO_PROFILE'] = options.profile;
}


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


async function stopProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  killTree(pid, 'SIGTERM');
  if (!(await waitForExit(pid, 20_000))) {
    killTree(pid, 'SIGKILL');
    await waitForExit(pid, 5_000);
  }
}


async function stopStack(options: ProfileOptions & { all?: boolean }): Promise<void> {
  applyProfileEnv(options);
  const host = readHostRuntime();
  const standalone = readRuntime();
  const ports = profilePortList(host, standalone);
  let stopped = false;

  if (options.all && standalone && isAlive(standalone.pid)) {
    await evictQueuePollers(getConfig().profile, standalone.pgPort);
  }

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

  let reaped = 0;
  for (const port of ports) {
    const pid = listenerPid(port);
    if (pid !== null && isAlive(pid)) {
      await stopProcess(pid);
      reaped += 1;
    }
  }

  const reapedProcs = options.all ? await reapRogueProcesses() : 0;

  const parts: string[] = [];
  if (reaped > 0) parts.push(`${reaped} orphan port owner${reaped === 1 ? '' : 's'}`);
  if (reapedProcs > 0) parts.push(`${reapedProcs} rogue process${reapedProcs === 1 ? '' : 'es'}`);
  if (parts.length > 0) console.log(`stopped (reaped ${parts.join(', ')})`);
  else console.log(stopped ? 'stopped' : 'not running');
}


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


async function restartStack(options: ProfileOptions): Promise<void> {
  applyProfileEnv(options);
  console.log('Restarting Revo stack…');
  await stopStack(options);
  await startStack(options);
}

type QueuePollerRogue = { pid: number; executorId: string; applicationName: string };






async function censusQueuePollers(
  profile: string,
  pgPort: number,
): Promise<{ rogues: QueuePollerRogue[]; unavailable: boolean }> {
  const client = new pg.Client(`postgresql://revisium:password@localhost:${pgPort}/postgres`);
  try {
    await client.connect();
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

type EvictResult = EvictionOutcome & { unavailable: boolean; cannotEvict: boolean };






async function evictQueuePollers(profile: string, pgPort: number): Promise<EvictResult> {
  const idle: EvictResult = { converged: false, rounds: 0, terminated: 0, unavailable: true, cannotEvict: false };
  const client = new pg.Client(`postgresql://revisium:password@localhost:${pgPort}/postgres`);
  try {
    await client.connect();
    const cap = await client.query(
      `SELECT (current_setting('is_superuser') = 'on' OR pg_has_role(current_user, 'pg_read_all_stats', 'MEMBER')) AS can_see,
              (current_setting('is_superuser') = 'on' OR pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')) AS can_signal`,
    );
    if (cap.rows[0]?.['can_see'] !== true) return idle;
    if (cap.rows[0]?.['can_signal'] !== true) {
      return { converged: false, rounds: 0, terminated: 0, unavailable: false, cannotEvict: true };
    }
    const owner = dbosExecutorId(profile);
    const dbosDb = resolveDbosDbName();
    const census = async (): Promise<number[]> => {
      const res = await client.query(
        `SELECT pid, application_name AS app FROM pg_stat_activity WHERE datname = $1 AND application_name LIKE 'dbos_transact_%'`,
        [dbosDb],
      );
      return classifyQueuePollerRogues(
        res.rows.map((r) => ({ pid: Number(r['pid']), applicationName: String(r['app']) })),
        owner,
      ).map((r) => r.pid);
    };
    const terminate = async (pid: number): Promise<void> => {
      await client.query('SELECT pg_terminate_backend($1)', [pid]);
    };
    const outcome = await evictByTermination(census, terminate);
    return { ...outcome, unavailable: false, cannotEvict: false };
  } catch {
    return idle;
  } finally {
    await client.end().catch(() => undefined);
  }
}





async function reapRogueProcesses(): Promise<number> {
  const protectedPids = new Set(allTrackedHostPids());
  const candidates: RevoProc[] = [];
  for (const { pid, command } of listProcesses()) {
    if (pid === process.pid) continue;
    const kind = classifyRevoProcess(command);
    if (kind === 'daemon') candidates.push({ pid, command, startTime: processStartTime(pid), kind });
  }
  const targets = selectReapTargets(candidates, protectedPids, parentPid);
  if (targets.length === 0) return 0;

  for (const t of targets) killTree(t.pid, 'SIGTERM');
  if (!(await waitForExit(targets[targets.length - 1].pid, 8_000))) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  for (const t of targets) {
    if (isAlive(t.pid) && processStartTime(t.pid) === t.startTime) killTree(t.pid, 'SIGKILL');
  }
  return targets.length;
}


async function doctorStack(options: ProfileOptions & { fix?: boolean }): Promise<void> {
  applyProfileEnv(options);
  const { profile, dataDir } = getConfig();

  const host = readHostRuntime();
  const hostAlive = host !== null && isAlive(host.pid);
  const hostHealthy = host !== null && hostAlive && (await isGraphqlHealthy(host.graphqlPort));

  const standalone = readRuntime();
  const standaloneAlive = standalone !== null && isAlive(standalone.pid);
  const standaloneHealthy = standalone !== null && standaloneAlive && (await isHealthy(standalone.httpPort));

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
    const owned = check.expected !== null && isPidWithin(pid, new Set([check.expected]));
    if (!owned) {
      unexpectedPortOwners.push({ label: check.label, port: check.port, pid });
    }
  }
  const versionMismatch =
    host?.version !== undefined ? { running: host.version, current: hostCodeVersion() } : undefined;

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
  if (report.ok) console.log('OK — stack is healthy.');
  else {
    for (const issue of report.issues) console.log(`✗ ${issue}`);
    process.exitCode = 1;
  }

  if (options.fix) {
    console.log('— fix: evicting rogue queue pollers —');
    if (standalone && standaloneAlive) {
      const e = await evictQueuePollers(profile, standalone.pgPort);
      if (e.unavailable) console.log('  connection eviction unavailable (DB unreachable / missing pg_read_all_stats)');
      else if (e.cannotEvict) console.log('  cannot terminate: role lacks pg_signal_backend');
      else
        console.log(
          `  terminated ${e.terminated} rogue connection(s) — ${e.converged ? 'converged' : 'NOT converged (reconnecting; process reap follows)'}`,
        );
    }
    const reaped = await reapRogueProcesses();
    console.log(`  reaped ${reaped} untracked revo process${reaped === 1 ? '' : 'es'}`);
  }
}

type LogsOptions = ProfileOptions & { lines?: string; follow?: boolean };
type LogTarget = { label: string; file: string };


function resolveLogTargets(target: string | undefined): LogTarget[] {
  const { logFile, hostLogFile } = getConfig();
  const host: LogTarget = { label: 'host', file: hostLogFile };
  const standalone: LogTarget = { label: 'standalone', file: logFile };
  if (target === 'host') return [host];
  if (target === 'standalone') return [standalone];
  return [host, standalone];
}


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


function prefixLines(label: string, chunk: string): string {
  return chunk
    .split('\n')
    .map((line) => (line === '' ? line : `[${label}] ${line}`))
    .join('\n');
}


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
    .option('--all', 'Also evict rogue queue pollers + reap untracked revo processes machine-wide')
    .action((options: ProfileOptions & { all?: boolean }) => stopStack(options));

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
    .option('--fix', 'Evict rogue queue pollers (terminate connections + reap untracked processes)')
    .action((options: ProfileOptions & { fix?: boolean }) => doctorStack(options));

  program
    .command('logs [target]')
    .description('Tail Revo logs (target: host | standalone; default both)')
    .option('--profile <name>', 'Runtime profile (default|dev)')
    .option('-n, --lines <count>', 'Lines to show from the end', String(DEFAULT_LOG_LINES))
    .option('-f, --follow', 'Stream new log output until interrupted')
    .action((target: string | undefined, options: LogsOptions) => logsStack(target, options));

  program
    .command('__daemon', { hidden: true })
    .description('Run the host daemon in the foreground (internal — spawned by `revo start`)')
    .action(() => runHostDaemon());
}
