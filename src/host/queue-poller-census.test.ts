import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExecutorId, classifyQueuePollerRogues, type PollerBackend } from './queue-poller-census.js';

test('parseExecutorId: extracts the executor id from a DBOS stamp', () => {
  assert.equal(parseExecutorId('dbos_transact_revo-default_1'), 'revo-default');
  assert.equal(parseExecutorId('dbos_transact_revo-dev_1'), 'revo-dev');
});

test('parseExecutorId: unpinned legacy host shows the `local` executor (empty version segment)', () => {
  assert.equal(parseExecutorId('dbos_transact_local_'), 'local');
});

test('parseExecutorId: tolerates a truncated/missing version segment (identity is before it)', () => {
  // A 63-byte truncation can cut the appVersion; the executor id precedes it and survives.
  assert.equal(parseExecutorId('dbos_transact_revo-default_0.1.0-alph'), 'revo-default');
});

test('parseExecutorId: returns null for non-DBOS application names', () => {
  assert.equal(parseExecutorId('psql'), null);
  assert.equal(parseExecutorId(''), null);
  assert.equal(parseExecutorId('dbos_transact_'), null); // prefix only, no id
});

const owner = 'revo-default';
const backends = (apps: Array<[number, string]>): PollerBackend[] =>
  apps.map(([pid, applicationName]) => ({ pid, applicationName }));

test('classifyQueuePollerRogues: the owner is not a rogue; a legacy `local` host is', () => {
  const rogues = classifyQueuePollerRogues(
    backends([
      [101, 'dbos_transact_revo-default_1'], // owner
      [102, 'dbos_transact_revo-default_1'], // owner (second pool conn)
      [201, 'dbos_transact_local_'], // legacy unpinned full-DBOS host
    ]),
    owner,
  );
  assert.equal(rogues.length, 1);
  assert.equal(rogues[0]?.pid, 201);
  assert.equal(rogues[0]?.executorId, 'local');
});

test('classifyQueuePollerRogues: a different profile owner is a rogue here', () => {
  const rogues = classifyQueuePollerRogues(backends([[301, 'dbos_transact_revo-dev_1']]), owner);
  assert.deepEqual(rogues.map((r) => r.executorId), ['revo-dev']);
});

test('classifyQueuePollerRogues: non-DBOS connections are ignored', () => {
  const rogues = classifyQueuePollerRogues(backends([[401, 'psql'], [402, 'pg_basebackup']]), owner);
  assert.equal(rogues.length, 0);
});

test('classifyQueuePollerRogues: a clean single-owner stack yields no rogues', () => {
  const rogues = classifyQueuePollerRogues(backends([[1, 'dbos_transact_revo-default_1']]), owner);
  assert.deepEqual(rogues, []);
});
