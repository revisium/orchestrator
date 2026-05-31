import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import {
  baseUrl,
  dataDir,
  findFreePort,
  healthUrl,
  isAlive,
  isHealthy,
  logFile,
  preferredPgPort,
  preferredPort,
  readRuntime,
  removeRuntime,
  runtimeFile,
} from '../config.js';

const require = createRequire(import.meta.url);

type StartOptions = {
  port?: string;
  pgPort?: string;
  data?: string;
};

type LogsOptions = {
  lines?: string;
  follow?: boolean;
};

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

async function waitHealthy(url: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.status < 500) return true;
    } catch {
      // Not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function tailLines(path: string, lines: number): string {
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf8');
  return content.split(/\r?\n/).slice(-lines).join('\n');
}

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return !isAlive(pid);
}

async function startRevisium(options: StartOptions): Promise<void> {
  const runtime = readRuntime();
  if (runtime && isAlive(runtime.pid)) {
    if (await isHealthy(runtime.httpPort)) {
      console.log(`already running on ${baseUrl(runtime.httpPort)}`);
      return;
    }

    console.log(`running (pid ${runtime.pid}) on ${baseUrl(runtime.httpPort)} but health FAILING`);
    process.exitCode = 1;
    return;
  }

  if (runtime) removeRuntime();

  const httpPort = await findFreePort(parsePort(options.port, preferredPort));
  const pgPort = await findFreePort(parsePort(options.pgPort, preferredPgPort));
  const standaloneDataDir = options.data ?? dataDir;
  const entry = require.resolve('@revisium/standalone/bin/revisium-standalone.js');
  const out = openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [entry, '--port', String(httpPort), '--pg-port', String(pgPort), '--data', standaloneDataDir],
    { detached: true, stdio: ['ignore', out, out] },
  );

  if (!child.pid) {
    throw new Error('Failed to start standalone Revisium');
  }

  child.unref();
  writeFileSync(
    runtimeFile,
    JSON.stringify({ httpPort, pgPort, pid: child.pid, startedAt: new Date().toISOString() }, null, 2),
  );

  if (!(await waitHealthy(healthUrl(httpPort)))) {
    console.error(`Revisium did not become healthy on ${baseUrl(httpPort)} within 120s`);
    console.error(tailLines(logFile, 20));
    killTree(child.pid, 'SIGTERM');
    await waitForExit(child.pid, 20_000);
    if (isAlive(child.pid)) killTree(child.pid, 'SIGKILL');
    removeRuntime();
    process.exitCode = 1;
    return;
  }

  console.log(`Revisium started (pid ${child.pid})`);
  console.log(`Admin: ${baseUrl(httpPort)}/`);
  console.log(`REST: ${baseUrl(httpPort)}/api`);
  console.log(`GraphQL: ${baseUrl(httpPort)}/graphql`);
  console.log(`MCP: ${baseUrl(httpPort)}/mcp`);
  console.log(`PostgreSQL port: ${pgPort}`);
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
    .option('-n <lines>', 'Number of log lines', '50')
    .option('-f, --follow', 'Follow log output')
    .action(logsRevisium);
}
