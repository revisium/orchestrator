import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDoctorReport, type TierObservation } from './doctor-report.js';

const healthy = (pid: number, port: number): TierObservation => ({
  present: true,
  alive: true,
  healthy: true,
  pid,
  port,
});

const absent: TierObservation = { present: false, alive: false, healthy: false, pid: null, port: null };

test('host down -> "not running"', () => {
  const r = buildDoctorReport({ host: absent });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, ['Stack is not running. Run `revo start`.']);
});

test('unexpected process on a profile port flags an untracked/duplicate daemon', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    unexpectedPortOwners: [{ label: 'GraphQL', port: 19223, pid: 777 }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /Unexpected process \(pid 777\).*19223.*duplicate daemon/.test(i)));
});

test('a rogue process while host.json is absent is still flagged', () => {
  const r = buildDoctorReport({
    host: absent,
    unexpectedPortOwners: [{ label: 'Postgres', port: 15440, pid: 888 }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.includes('pid 888')), 'reports the rogue process');
  assert.ok(!r.issues.includes('Stack is not running. Run `revo start`.'), 'not the plain down message');
});

test('version mismatch flags a stale daemon and suggests restart', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    versionMismatch: { running: '0.1.0-alpha.6', current: '0.1.0-alpha.7' },
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /version 0\.1\.0-alpha\.6 but this build is 0\.1\.0-alpha\.7.*revo restart/.test(i)));
});

test('matching version plus no rogue ports has no false issues', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    unexpectedPortOwners: [],
    versionMismatch: { running: '0.1.0-alpha.7', current: '0.1.0-alpha.7' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('rogue queue poller flags a foreign executor on the dbos DB with backend pids', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    queuePollerRogues: [
      { pid: 501, executorId: 'local', applicationName: 'dbos_transact_local_' },
      { pid: 502, executorId: 'local', applicationName: 'dbos_transact_local_' },
    ],
  });
  assert.equal(r.ok, false);
  assert.ok(
    r.issues.some((i) => /foreign executor "local".*501, 502.*dev-tasks.*pkill/.test(i)),
    'reports the foreign executor, its backend pids, and the reap remedy',
  );
});

test('rogue census groups distinct foreign executors into distinct issues', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    queuePollerRogues: [
      { pid: 601, executorId: 'local', applicationName: 'dbos_transact_local_' },
      { pid: 602, executorId: 'revo-dev', applicationName: 'dbos_transact_revo-dev_1' },
    ],
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues.filter((i) => i.includes('foreign executor')).length, 2);
});

test('census unavailable warns and never reports clean', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    queuePollerRogues: [],
    rogueCensusUnavailable: true,
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /Could not census.*single-ownership could not be verified/.test(i)));
});

test('census ran clean with no rogues has no false issue', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    queuePollerRogues: [],
    rogueCensusUnavailable: false,
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('healthy host has no issues', () => {
  const r = buildDoctorReport({ host: healthy(100, 19223) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('stale host.json is flagged with the pid', () => {
  const r = buildDoctorReport({
    host: { present: true, alive: false, healthy: false, pid: 999, port: 19223 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /Stale host\.json.*999/);
});

test('host alive but GraphQL not responding is flagged with the port', () => {
  const r = buildDoctorReport({
    host: { present: true, alive: true, healthy: false, pid: 100, port: 19223 },
  });
  assert.equal(r.ok, false);
  assert.match(r.issues[0], /GraphQL front door on port 19223/);
});
