import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAlive, isPortFree, repoRoot } from '../../config.js';
import { killTree, waitForExit } from '../../cli/commands/process-helpers.js';
import { readHostRuntimeAt, type HostRuntimeState } from '../../host/host-runtime.js';

export type ProcessResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function cleanEnvironment(overrides: Readonly<Record<string, string>>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  delete inherited['REVO_PROFILE'];
  return { ...inherited, ...overrides };
}

async function findPortBand(from: number, width: number): Promise<number> {
  for (let port = from; port < 60_000 - width; port += width + 1) {
    const free = await Promise.all(Array.from({ length: width }, (_, offset) => isPortFree(port + offset)));
    if (free.every(Boolean)) return port;
  }
  throw new Error(`no ${width}-port band is available from ${from}`);
}

function postmasterPid(dataDir: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(dataDir, 'pgdata', 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export class IsolatedProfile {
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly #observedHostPids = new Set<number>();

  constructor(dataDir: string, env: Readonly<Record<string, string>>) {
    this.dataDir = dataDir;
    this.env = env;
  }

  runtime(): HostRuntimeState | null {
    const runtime = readHostRuntimeAt(join(this.dataDir, 'host.json'));
    if (runtime) this.#observedHostPids.add(runtime.pid);
    return runtime;
  }

  running(): boolean {
    const runtime = this.runtime();
    return runtime !== null && isAlive(runtime.pid);
  }

  async run(args: readonly string[], timeoutMs = 240_000): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', join(repoRoot, 'src/cli/index.ts'), ...args],
        {
          cwd: repoRoot,
          env: this.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        if (child.pid) killTree(child.pid, 'SIGKILL');
        reject(new Error(`CLI ${args.join(' ')} exceeded ${timeoutMs} ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }, timeoutMs);
      timer.unref();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
    });
  }

  async cleanup(): Promise<void> {
    await this.run(['stop'], 30_000).catch(() => undefined);
    this.runtime();
    for (const pid of this.#observedHostPids) {
      if (!isAlive(pid)) continue;
      killTree(pid, 'SIGKILL');
      await waitForExit(pid, 5_000);
    }
    const postgres = postmasterPid(this.dataDir);
    if (postgres && isAlive(postgres)) {
      killTree(postgres, 'SIGKILL');
      await waitForExit(postgres, 5_000);
    }
    rmSync(this.dataDir, { recursive: true, force: true });
  }
}

export async function createIsolatedProfile(label: string): Promise<IsolatedProfile> {
  const dataDir = mkdtempSync(join(tmpdir(), `revo-${label}-`));
  try {
    const seed = 20_000 + (process.pid % 1_500) * 20;
    const basePort = await findPortBand(seed, 3);
    const pgPort = await findPortBand(52_000 + (process.pid % 1_500), 1);
    const suffix = dataDir.replace(/[^a-zA-Z0-9]/g, '_').slice(-32);
    return new IsolatedProfile(dataDir, cleanEnvironment({
      REVO_DATA_DIR: dataDir,
      REVO_PORT: String(basePort),
      REVO_PG_PORT: String(pgPort),
      REVO_DBOS_DB: `dbos_${suffix}`,
      REVO_PROJECT: `e2e-${label}-${process.pid}`,
      REVO_SHUTDOWN_DRAIN_TIMEOUT_MS: '100',
    }));
  } catch (error) {
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}
