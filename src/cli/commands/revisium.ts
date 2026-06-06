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
};

async function startRevisium(options: StartOptions): Promise<void> {
  try {
    const { runtime, alreadyRunning } = await ensureRevisium(options);
    if (alreadyRunning) {
      console.log(`already running on ${baseUrl(runtime.httpPort)}`);
      return;
    }
    console.log(`Revisium started (pid ${runtime.pid})`);
    console.log(`Admin: ${baseUrl(runtime.httpPort)}/`);
    console.log(`REST: ${baseUrl(runtime.httpPort)}/api`);
    console.log(`GraphQL: ${baseUrl(runtime.httpPort)}/graphql`);
    console.log(`MCP: ${baseUrl(runtime.httpPort)}/mcp`);
    console.log(`PostgreSQL port: ${runtime.pgPort}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function stopRevisium(): Promise<void> {
  const runtime = readRuntime();
  if (!runtime) {
    console.log('not running');
    return;
  }

  if (isAlive(runtime.pid)) {
    killTree(runtime.pid, 'SIGTERM');
    const exited = await waitForExit(runtime.pid, 20_000);
    if (!exited) {
      killTree(runtime.pid, 'SIGKILL');
      await waitForExit(runtime.pid, 5_000);
    }
  }

  removeRuntime();
  console.log('stopped');
}

async function statusRevisium(): Promise<void> {
  const runtime = readRuntime();
  if (!runtime || !isAlive(runtime.pid)) {
    if (runtime) removeRuntime();
    console.log('stopped');
    return;
  }

  if (await isHealthy(runtime.httpPort)) {
    console.log(`running (pid ${runtime.pid}) on ${baseUrl(runtime.httpPort)} - health OK`);
  } else {
    console.log(`running (pid ${runtime.pid}) on ${baseUrl(runtime.httpPort)} but health FAILING`);
  }
}

function logsRevisium(options: LogsOptions): void {
  const { logFile } = getConfig();
  const lines = Number(options.lines ?? 50);
  if (!Number.isInteger(lines) || lines <= 0) {
    throw new Error(`Invalid line count: ${options.lines}`);
  }

  if (options.follow) {
    const child = spawn('tail', ['-n', String(lines), '-f', logFile], { stdio: 'inherit' });
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
    });
    return;
  }

  const output = tailLines(logFile, lines);
  if (output) console.log(output);
}

export function registerRevisium(program: Command): void {
  const revisium = program.command('revisium').description('Manage local standalone Revisium');

  revisium
    .command('start')
    .option('--port <n>', 'HTTP port scan base')
    .option('--pg-port <n>', 'PostgreSQL port scan base')
    .option('--data <dir>', 'Standalone data directory')
    .action(startRevisium);

  revisium.command('stop').action(stopRevisium);
  revisium.command('status').action(statusRevisium);

  revisium
    .command('logs')
    .option('-n, --lines <lines>', 'Number of log lines', '50')
    .option('-f, --follow', 'Follow log output')
    .action(logsRevisium);
}
