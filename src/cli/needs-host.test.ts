import test from 'node:test';
import assert from 'node:assert/strict';
import { needsHost } from './needs-host.js';

// Helper: build a process.argv-style array (node + script + args).
function argv(...args: string[]): string[] {
  return ['node', 'revo', ...args];
}

// ── Host-FREE (false) ────────────────────────────────────────────────────────

test('needsHost: empty argv → false', () => {
  assert.equal(needsHost(argv()), false);
});

test('needsHost: unknown command → false (fail-safe)', () => {
  assert.equal(needsHost(argv('dve:ping')), false);
});

test('needsHost: revisium start → false', () => {
  assert.equal(needsHost(argv('revisium', 'start')), false);
});

test('needsHost: revisium stop → false', () => {
  assert.equal(needsHost(argv('revisium', 'stop')), false);
});

test('needsHost: revisium status → false', () => {
  assert.equal(needsHost(argv('revisium', 'status')), false);
});

test('needsHost: revisium logs → false', () => {
  assert.equal(needsHost(argv('revisium', 'logs')), false);
});

test('needsHost: bootstrap → false', () => {
  assert.equal(needsHost(argv('bootstrap')), false);
});

test('needsHost: run list → false', () => {
  assert.equal(needsHost(argv('run', 'list')), false);
});

test('needsHost: run create → false', () => {
  assert.equal(needsHost(argv('run', 'create', '--title', 'X', '--repo', '.')), false);
});

test('needsHost: run show → false', () => {
  assert.equal(needsHost(argv('run', 'show', 'run-1')), false);
});

test('needsHost: run events → false', () => {
  assert.equal(needsHost(argv('run', 'events', 'run-1')), false);
});

test('needsHost: run cancel → false', () => {
  assert.equal(needsHost(argv('run', 'cancel', 'run-1')), false);
});

test('needsHost: run start → true (host-requiring)', () => {
  assert.equal(needsHost(argv('run', 'start', 'run-id-1')), true);
});

test('needsHost: run start --stub → true', () => {
  assert.equal(needsHost(argv('run', 'start', 'run-id-1', '--stub')), true);
});

test('needsHost: run start --help → false (help wins)', () => {
  assert.equal(needsHost(argv('run', 'start', '--help')), false);
});

test('needsHost: work → false', () => {
  assert.equal(needsHost(argv('work', '--once')), false);
});

test('needsHost: --help anywhere → false (even before dev:ping)', () => {
  assert.equal(needsHost(argv('dev:ping', '--help')), false);
});

test('needsHost: -h → false', () => {
  assert.equal(needsHost(argv('-h')), false);
});

test('needsHost: --version → false', () => {
  assert.equal(needsHost(argv('--version')), false);
});

test('needsHost: -v → false', () => {
  assert.equal(needsHost(argv('-v')), false);
});

test('needsHost: dev:status --help → false (help flag wins)', () => {
  assert.equal(needsHost(argv('dev:status', 'some-id', '--help')), false);
});

// ── HOST-requiring (true) ────────────────────────────────────────────────────

test('needsHost: dev:ping → true', () => {
  assert.equal(needsHost(argv('dev:ping')), true);
});

test('needsHost: dev:ping --sleep 100 → true (flag does not count as command)', () => {
  assert.equal(needsHost(argv('dev:ping', '--sleep', '100')), true);
});

test('needsHost: dev:ping --id wf-1 → true', () => {
  assert.equal(needsHost(argv('dev:ping', '--id', 'wf-1')), true);
});

test('needsHost: dev:status <id> → true', () => {
  assert.equal(needsHost(argv('dev:status', 'wf-resume-1')), true);
});
