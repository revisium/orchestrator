import { spawn } from 'node:child_process';
import { Command } from 'commander';
import {
  baseUrl,
  getConfig,
  isAlive,
  isHealthy,
  readRuntime,
  removeRuntime,
} from '../config.js';
import { ensureRevisium } from '../../host/ensure-revisium.js';
import { killTree, tailLines, waitForExit } from './revisium-helpers.js';

type StartOptions = {
  port?: string;
  pgPort?: string;
  data?: string;
};

type LogsOptions = {
  lines?: string;
  follow?: boolean;
  data?: string;
};

type NamespaceOptions = {
  port?: string;
  pgPort?: string;
  data?: string;
};

export type RevisiumDeps = {
  ensureRevisium: typeof ensureRevisium;
  baseUrl: typeof baseUrl;
  getConfig: typeof getConfig;
  isAlive: typeof isAlive;
  isHealthy: typeof isHealthy;
  readRuntime: typeof readRuntime;
  removeRuntime: typeof removeRuntime;
  killTree: typeof killTree;
  tailLines: typeof tailLines;
  waitForExit: typeof waitForExit;
  spawn: typeof spawn;
  env: NodeJS.ProcessEnv;
  log: (message?: unknown) => void;
  error: (message?: unknown) => void;
  setExitCode: (code: number) => void;
};

const defaultDeps: RevisiumDeps = {
  ensureRevisium,
  baseUrl,
  getConfig,
  isAlive,
  isHealthy,
  readRuntime,
  removeRuntime,
  killTree,
  tailLines,
  waitForExit,
  spawn,
  env: process.env,
  log: (message?: unknown) => console.log(message),
  error: (message?: unknown) => console.error(message),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function applyNamespaceEnv(options: NamespaceOptions, env: NodeJS.ProcessEnv = process.env): void {
  if (options.data) env.REVO_DATA_DIR = options.data;
  if (options.port) env.REVO_PORT = options.port;
  if (options.pgPort) env.REVO_PG_PORT = options.pgPort;
}

export async function startRevisium(options: StartOptions, deps: RevisiumDeps = defaultDeps): Promise<void> {
  applyNamespaceEnv(options, deps.env);
  try {
    const { runtime, alreadyRunning } = await deps.ensureRevisium(options);
    if (alreadyRunning) {
      deps.log(`already running on ${deps.baseUrl(runtime.httpPort)}`);
      return;
    }
    deps.log(`Revisium started (pid ${runtime.pid})`);
    deps.log(`Admin: ${deps.baseUrl(runtime.httpPort)}/`);
    deps.log(`REST: ${deps.baseUrl(runtime.httpPort)}/api`);
    deps.log(`GraphQL: ${deps.baseUrl(runtime.httpPort)}/graphql`);
    deps.log(`MCP: ${deps.baseUrl(runtime.httpPort)}/mcp`);
    deps.log(`PostgreSQL port: ${runtime.pgPort}`);
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.setExitCode(1);
  }
}

export async function stopRevisium(options: NamespaceOptions = {}, deps: RevisiumDeps = defaultDeps): Promise<void> {
  applyNamespaceEnv(options, deps.env);
  const runtime = deps.readRuntime();
  if (!runtime) {
    deps.log('not running');
    return;
  }

  if (deps.isAlive(runtime.pid)) {
    deps.killTree(runtime.pid, 'SIGTERM');
    const exited = await deps.waitForExit(runtime.pid, 20_000);
    if (!exited) {
      deps.killTree(runtime.pid, 'SIGKILL');
      await deps.waitForExit(runtime.pid, 5_000);
    }
  }

  deps.removeRuntime();
  deps.log('stopped');
}

export async function statusRevisium(options: NamespaceOptions = {}, deps: RevisiumDeps = defaultDeps): Promise<void> {
  applyNamespaceEnv(options, deps.env);
  const runtime = deps.readRuntime();
  if (!runtime || !deps.isAlive(runtime.pid)) {
    if (runtime) deps.removeRuntime();
    deps.log('stopped');
    return;
  }

  if (await deps.isHealthy(runtime.httpPort)) {
    deps.log(`running (pid ${runtime.pid}) on ${deps.baseUrl(runtime.httpPort)} - health OK`);
  } else {
    deps.log(`running (pid ${runtime.pid}) on ${deps.baseUrl(runtime.httpPort)} but health FAILING`);
  }
}

export function logsRevisium(options: LogsOptions, deps: RevisiumDeps = defaultDeps): void {
  applyNamespaceEnv(options, deps.env);
  const { logFile } = deps.getConfig();
  const lines = Number(options.lines ?? 50);
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error(`Invalid line count: ${options.lines}`);
  }

  if (options.follow) {
    const child = deps.spawn('tail', ['-n', String(lines), '-f', logFile], { stdio: 'inherit' });
    child.on('exit', (code) => {
      deps.setExitCode(code ?? 0);
    });
    return;
  }

  const output = deps.tailLines(logFile, lines);
  if (output) deps.log(output);
}

export function registerRevisium(program: Command, deps: RevisiumDeps = defaultDeps): void {
  const revisium = program.command('revisium').description('Manage local standalone Revisium');

  revisium
    .command('start')
    .option('--port <n>', 'HTTP port scan base')
    .option('--pg-port <n>', 'PostgreSQL port scan base')
    .option('--data <dir>', 'Standalone data directory')
    .action((options: StartOptions) => startRevisium(options, deps));

  revisium.command('stop').option('--data <dir>', 'Standalone data directory').action((options: NamespaceOptions) => stopRevisium(options, deps));
  revisium.command('status').option('--data <dir>', 'Standalone data directory').action((options: NamespaceOptions) => statusRevisium(options, deps));

  revisium
    .command('logs')
    .option('-n, --lines <lines>', 'Number of log lines', '50')
    .option('-f, --follow', 'Follow log output')
    .option('--data <dir>', 'Standalone data directory')
    .action((options: LogsOptions) => logsRevisium(options, deps));
}
