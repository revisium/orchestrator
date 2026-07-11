import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCliContext } from '../../support/cli-context.js';
import { e2eSkip } from '../../support/env.js';

test('CLI subprocess start/status/restart/status/stop exposes output and process effects', { skip: e2eSkip }, async () => {
  const cli = await createCliContext();
  try {
    const started = await cli.start();
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /Revo started|already running/);
    assert.equal(started.stderr, '');
    const first = cli.hostState();
    assert.equal(first.running, true);
    assert.ok(first.pid);

    const status = await cli.status();
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Host daemon: running/);
    assert.match(status.stdout, /GraphQL .* OK/);
    assert.equal(status.stderr, '');

    const restarted = await cli.restart();
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.match(restarted.stdout, /Restarting Revo stack/);
    assert.equal(restarted.stderr, '');
    const second = cli.hostState();
    assert.equal(second.running, true);
    assert.ok(second.pid);
    assert.notEqual(second.pid, first.pid);
    assert.equal(cli.hostProcessAlive(first.pid), false);

    const restartedStatus = await cli.status();
    assert.equal(restartedStatus.status, 0, restartedStatus.stderr);
    assert.match(restartedStatus.stdout, /Host daemon: running/);
    assert.equal(restartedStatus.stderr, '');

    const stopped = await cli.stop();
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /stopped/);
    assert.equal(stopped.stderr, '');
    assert.equal(cli.hostState().running, false);
    assert.equal(cli.hostProcessAlive(second.pid), false);
  } finally {
    await cli.cleanup();
  }
});

test('CLI subprocess failure retains exit status, stdout, and stderr', { skip: e2eSkip }, async () => {
  const cli = await createCliContext();
  try {
    const result = await cli.invoke(['not-a-command']);
    assert.notEqual(result.status, 0);
    assert.equal(typeof result.stdout, 'string');
    assert.match(result.stderr, /unknown command/i);
    assert.equal(cli.hostState().running, false);
  } finally {
    await cli.cleanup();
  }
});
