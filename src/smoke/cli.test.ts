import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { assertIncludes, matchId, runCli } from './cli.js';

type SpawnCall = {
  command: string;
  args: readonly string[];
  options: unknown;
};

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

function fakeSpawn(
  onSpawn: (call: SpawnCall, child: FakeChild) => void,
): typeof spawn {
  return ((command: string, args: readonly string[], options: unknown) => {
    const child = new FakeChild();
    onSpawn({ command, args, options }, child);
    return child;
  }) as unknown as typeof spawn;
}

test('runCli constructs a tsx command and collects stdout/stderr', async () => {
  let call: SpawnCall | undefined;
  const result = await runCli(['run', 'status', 'run-1'], {
    tsxCliPath: '/tmp/tsx-cli',
    spawn: fakeSpawn((spawnCall, child) => {
      call = spawnCall;
      queueMicrotask(() => {
        child.stdout.write('out\n');
        child.stderr.write('err\n');
        child.emit('close', 7);
      });
    }),
  });

  assert.equal(call?.command, process.execPath);
  assert.deepEqual(call?.args, ['/tmp/tsx-cli', 'src/cli/index.ts', 'run', 'status', 'run-1']);
  assert.deepEqual(call?.options, { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(result, { stdout: 'out\n', stderr: 'err\n', status: 7 });
});

test('runCli resolves the local tsx CLI path when no override is supplied', async () => {
  const calls: SpawnCall[] = [];
  await runCli(['--version'], {
    spawn: fakeSpawn((spawnCall, child) => {
      calls.push(spawnCall);
      queueMicrotask(() => child.emit('close', 0));
    }),
  });
  await runCli(['--help'], {
    spawn: fakeSpawn((spawnCall, child) => {
      calls.push(spawnCall);
      queueMicrotask(() => child.emit('close', 0));
    }),
  });

  assert.equal(calls[0]?.command, process.execPath);
  assert.match(calls[0]?.args[0] ?? '', /tsx/);
  assert.equal(calls[1]?.args[0], calls[0]?.args[0]);
  assert.deepEqual(calls[0]?.args.slice(1), ['src/cli/index.ts', '--version']);
  assert.deepEqual(calls[1]?.args.slice(1), ['src/cli/index.ts', '--help']);
});

test('runCli rejects when spawning the CLI fails', async () => {
  const failure = new Error('spawn failed');
  await assert.rejects(
    () =>
      runCli(['status'], {
        tsxCliPath: '/tmp/tsx-cli',
        spawn: fakeSpawn((_spawnCall, child) => {
          queueMicrotask(() => child.emit('error', failure));
        }),
      }),
    failure,
  );
});

test('matchId returns the first capture group', () => {
  assert.equal(matchId('runId=run_123\n', /runId=(run_\d+)/, 'run id'), 'run_123');
});

test('matchId throws with the label and output when parsing fails', () => {
  assert.throws(
    () => matchId('no id here', /runId=(run_\d+)/, 'run id'),
    /Could not parse run id from CLI output:\nno id here/,
  );
});

test('assertIncludes accepts matching output', () => {
  assert.doesNotThrow(() => assertIncludes('status: ready', 'ready', 'run status'));
});

test('assertIncludes throws with the label and output when text is missing', () => {
  assert.throws(
    () => assertIncludes('status: blocked', 'ready', 'run status'),
    /run status: expected output to include "ready"\.\nGot:\nstatus: blocked/,
  );
});
