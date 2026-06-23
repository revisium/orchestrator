/**
 * doctor-report.test.ts — the `revo doctor` diagnosis rules.
 *
 * buildDoctorReport is pure (no IO), so every stack state is exercised here as a plain input:
 * down, healthy, stale pid, unhealthy, and the two partial-stack permutations. lifecycle.ts only
 * gathers the observations (read files + probe ports) and prints — it has no decision logic to test.
 */
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

test('both tiers down → "not running", not an error condition', () => {
  const r = buildDoctorReport({ host: absent, standalone: absent });
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues, ['Stack is not running. Run `revo start`.']);
});

test('both tiers healthy → ok with no issues', () => {
  const r = buildDoctorReport({ host: healthy(100, 19223), standalone: healthy(101, 19222) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.issues, []);
});

test('stale host.json (recorded pid dead) is flagged with the pid', () => {
  const r = buildDoctorReport({
    host: { present: true, alive: false, healthy: false, pid: 999, port: 19223 },
    standalone: healthy(101, 19222),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /Stale host\.json.*999/);
});

test('host alive but GraphQL not responding is flagged with the port', () => {
  const r = buildDoctorReport({
    host: { present: true, alive: true, healthy: false, pid: 100, port: 19223 },
    standalone: healthy(101, 19222),
  });
  assert.equal(r.ok, false);
  assert.match(r.issues[0], /GraphQL front door on port 19223/);
});

test('stale standalone runtime.json (recorded pid dead) is flagged', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    standalone: { present: true, alive: false, healthy: false, pid: 888, port: 19222 },
  });
  assert.equal(r.ok, false);
  assert.match(r.issues[0], /Stale runtime\.json.*888/);
});

test('standalone alive but unhealthy is flagged with the port', () => {
  const r = buildDoctorReport({
    host: healthy(100, 19223),
    standalone: { present: true, alive: true, healthy: false, pid: 101, port: 19222 },
  });
  assert.equal(r.ok, false);
  assert.match(r.issues[0], /unhealthy on port 19222/);
});

test('host up but standalone absent → partial stack, suggests restart', () => {
  const r = buildDoctorReport({ host: healthy(100, 19223), standalone: absent });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /partial.*revo restart/);
});

test('standalone up but host absent → partial stack, suggests start', () => {
  const r = buildDoctorReport({ host: absent, standalone: healthy(101, 19222) });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /Host daemon is not running.*partial.*revo start/);
});

// A stale tier (present-but-dead) must NOT be reported as "running" by the other tier's
// partial-stack message — that gates on `alive`, so only the stale issue surfaces.
test('stale host + standalone absent reports only the stale host, not a partial stack', () => {
  const r = buildDoctorReport({
    host: { present: true, alive: false, healthy: false, pid: 999, port: 19223 },
    standalone: absent,
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /Stale host\.json/);
});

test('stale standalone + host absent reports only the stale standalone, not a partial stack', () => {
  const r = buildDoctorReport({
    host: absent,
    standalone: { present: true, alive: false, healthy: false, pid: 888, port: 19222 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues.length, 1);
  assert.match(r.issues[0], /Stale runtime\.json/);
});
