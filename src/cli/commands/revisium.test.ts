import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Command } from 'commander';
import {
  applyNamespaceEnv,
  logsRevisium,
  registerRevisium,
  startRevisium,
  stopRevisium,
  statusRevisium,
  type RevisiumDeps,
} from './revisium.js';
import type { RuntimeState } from '../config.js';

const RUNTIME: RuntimeState = {
  httpPort: 19222,
  pgPort: 15440,
  pid: 12345,
  startedAt: '2026-06-22T00:00:00.000Z',
  dataDir: '/tmp/revo-data',
};

function makeDeps(overrides: Partial<RevisiumDeps> = {}): {
  deps: RevisiumDeps;
  env: NodeJS.ProcessEnv;
  logs: string[];
  errors: string[];
  exitCodes: number[];
  kills: Array<{ pid: number; signal: NodeJS.Signals }>;
} {
  const env: NodeJS.ProcessEnv = {};
  const logs: string[] = [];
  const errors: string[] = [];
  const exitCodes: number[] = [];
  const kills: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  const deps: RevisiumDeps = {
    ensureRevisium: async () => ({ runtime: RUNTIME, alreadyRunning: true }),
    baseUrl: (port) => `http://127.0.0.1:${port}`,
    getConfig: () => ({
      host: '127.0.0.1',
      preferredPort: 19222,
      preferredPgPort: 15440,
      autoDiscover: true,
      dataDir: env.REVO_DATA_DIR ?? '/tmp/revo-data',
      profile: 'default',
      org: 'admin',
      project: 'control-plane',
      branch: 'master',
      logFile: `${env.REVO_DATA_DIR ?? '/tmp/revo-data'}/standalone.log`,
      runtimeFile: `${env.REVO_DATA_DIR ?? '/tmp/revo-data'}/runtime.json`,
    }),
    isAlive: () => false,
    isHealthy: async () => true,
    readRuntime: () => null,
    removeRuntime: () => undefined,
    killTree: (pid, signal) => {
      kills.push({ pid, signal });
    },
    tailLines: () => '',
    waitForExit: async () => true,
    spawn: (() => {
      throw new Error('unexpected spawn');
    }) as typeof spawn,
    env,
    log: (message?: unknown) => {
      logs.push(String(message ?? ''));
    },
    error: (message?: unknown) => {
      errors.push(String(message ?? ''));
    },
    setExitCode: (code) => {
      exitCodes.push(code);
    },
    ...overrides,
  };

  return { deps, env, logs, errors, exitCodes, kills };
}

async function parseRevisium(args: string[], deps: RevisiumDeps): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerRevisium(program, deps);
  await program.parseAsync(args, { from: 'user' });
}

test('applyNamespaceEnv maps data and ports into the selected environment', () => {
  const env: NodeJS.ProcessEnv = {};
  applyNamespaceEnv({ data: '/tmp/revo-a', port: '20001', pgPort: '25001' }, env);
  assert.equal(env.REVO_DATA_DIR, '/tmp/revo-a');
  assert.equal(env.REVO_PORT, '20001');
  assert.equal(env.REVO_PG_PORT, '25001');
});

test('registerRevisium exposes --data on start/status/stop/logs', () => {
  const program = new Command();
  registerRevisium(program, makeDeps().deps);
  const revisium = program.commands.find((command) => command.name() === 'revisium');
  assert.ok(revisium);

  for (const name of ['start', 'status', 'stop', 'logs']) {
    const command = revisium.commands.find((candidate) => candidate.name() === name);
    assert.ok(command, `${name} command must exist`);
    assert.match(command.helpInformation(), /--data <dir>/, `${name} must expose --data`);
  }
});

test('revisium start --data sets namespace env before ensureRevisium', async () => {
  const { deps, env, logs } = makeDeps({
    ensureRevisium: async (options) => {
      assert.equal(env.REVO_DATA_DIR, '/tmp/revo-start');
      assert.equal(env.REVO_PORT, '20002');
      assert.equal(env.REVO_PG_PORT, '25002');
      assert.deepEqual(options, { data: '/tmp/revo-start', port: '20002', pgPort: '25002' });
      return { runtime: RUNTIME, alreadyRunning: false };
    },
  });

  await parseRevisium(['revisium', 'start', '--data', '/tmp/revo-start', '--port', '20002', '--pg-port', '25002'], deps);

  assert.equal(logs[0], 'Revisium started (pid 12345)');
  assert.ok(logs.includes('PostgreSQL port: 15440'));
});

test('startRevisium reports ensure errors without throwing', async () => {
  const { deps, errors, exitCodes } = makeDeps({
    ensureRevisium: async () => {
      throw new Error('cannot start');
    },
  });

  await startRevisium({ data: '/tmp/revo-start-error' }, deps);

  assert.deepEqual(errors, ['cannot start']);
  assert.deepEqual(exitCodes, [1]);
});

test('startRevisium reports non-Error ensure failures without throwing', async () => {
  const { deps, errors, exitCodes } = makeDeps({
    ensureRevisium: async () => {
      throw new String('cannot start');
    },
  });

  await startRevisium({ data: '/tmp/revo-start-string-error' }, deps);

  assert.deepEqual(errors, ['cannot start']);
  assert.deepEqual(exitCodes, [1]);
});

test('revisium status --data uses the selected namespace and removes stale runtime', async () => {
  let removed = false;
  const { deps, env, logs } = makeDeps({
    readRuntime: () => RUNTIME,
    isAlive: () => {
      assert.equal(env.REVO_DATA_DIR, '/tmp/revo-status');
      return false;
    },
    removeRuntime: () => {
      removed = true;
    },
  });

  await parseRevisium(['revisium', 'status', '--data', '/tmp/revo-status'], deps);

  assert.equal(removed, true);
  assert.deepEqual(logs, ['stopped']);
});

test('statusRevisium prints healthy runtime details', async () => {
  const { deps, logs } = makeDeps({
    readRuntime: () => RUNTIME,
    isAlive: () => true,
    isHealthy: async () => true,
  });

  await statusRevisium({ data: '/tmp/revo-status-healthy' }, deps);

  assert.deepEqual(logs, ['running (pid 12345) on http://127.0.0.1:19222 - health OK']);
});

test('revisium stop --data uses the selected namespace and escalates a stuck process', async () => {
  const waits: number[] = [];
  const { deps, env, logs, kills } = makeDeps({
    readRuntime: () => RUNTIME,
    isAlive: () => {
      assert.equal(env.REVO_DATA_DIR, '/tmp/revo-stop');
      return true;
    },
    waitForExit: async (_pid, timeoutMs) => {
      waits.push(timeoutMs);
      return timeoutMs !== 20_000;
    },
  });

  await parseRevisium(['revisium', 'stop', '--data', '/tmp/revo-stop'], deps);

  assert.deepEqual(kills, [
    { pid: 12345, signal: 'SIGTERM' },
    { pid: 12345, signal: 'SIGKILL' },
  ]);
  assert.deepEqual(waits, [20_000, 5_000]);
  assert.deepEqual(logs, ['stopped']);
});

test('stopRevisium removes runtime after a graceful process exit', async () => {
  let removed = false;
  const { deps, logs, kills } = makeDeps({
    readRuntime: () => RUNTIME,
    isAlive: () => true,
    waitForExit: async (_pid, timeoutMs) => {
      assert.equal(timeoutMs, 20_000);
      return true;
    },
    removeRuntime: () => {
      removed = true;
    },
  });

  await stopRevisium({ data: '/tmp/revo-stop-graceful' }, deps);

  assert.equal(removed, true);
  assert.deepEqual(kills, [{ pid: 12345, signal: 'SIGTERM' }]);
  assert.deepEqual(logs, ['stopped']);
});

test('revisium logs --data reads the selected namespace log file', async () => {
  const { deps, env, logs } = makeDeps({
    tailLines: (path, lines) => {
      assert.equal(env.REVO_DATA_DIR, '/tmp/revo-logs');
      assert.equal(path, '/tmp/revo-logs/standalone.log');
      assert.equal(lines, 2);
      return 'line 1\nline 2';
    },
  });

  await parseRevisium(['revisium', 'logs', '--data', '/tmp/revo-logs', '--lines', '2'], deps);

  assert.deepEqual(logs, ['line 1\nline 2']);
});

test('logsRevisium rejects invalid line counts before reading a log file', () => {
  const { deps } = makeDeps({
    tailLines: () => {
      throw new Error('tailLines must not run');
    },
  });

  assert.throws(() => logsRevisium({ data: '/tmp/revo-logs', lines: '0' }, deps), /Invalid line count: 0/);
});

test('logsRevisium follow mode tails the selected namespace log file', () => {
  const { deps, env, exitCodes } = makeDeps({
    spawn: ((command: string, args: readonly string[], options: unknown) => {
      assert.equal(env.REVO_DATA_DIR, '/tmp/revo-logs-follow');
      assert.equal(command, 'tail');
      assert.deepEqual(args, ['-n', '3', '-f', '/tmp/revo-logs-follow/standalone.log']);
      assert.deepEqual(options, { stdio: 'inherit' });
      return {
        on: (event: string, listener: (code: number | null) => void) => {
          assert.equal(event, 'exit');
          listener(null);
          return undefined;
        },
      };
    }) as unknown as typeof spawn,
  });

  logsRevisium({ data: '/tmp/revo-logs-follow', lines: '3', follow: true }, deps);

  assert.deepEqual(exitCodes, [0]);
});
