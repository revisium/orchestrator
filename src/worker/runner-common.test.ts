import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedPreview, runnerTimeoutFailure } from './runner-common.js';
import {
  RUNNER_IDLE_TIMEOUT_KIND,
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  type ExecResult,
  type RunnerTimeoutPolicy,
} from './process-executor.js';

test('runner common: boundedPreview handles undefined root values', () => {
  assert.equal(boundedPreview(undefined), 'undefined');
});

test('runner common: boundedPreview still returns bounded JSON for normal values', () => {
  const preview = boundedPreview({ text: 'x'.repeat(2_000) });

  assert.ok(preview.length <= 1_003);
  assert.match(preview, /\.\.\./);
});

test('runner common: fallback timeout evidence uses idle values for idle timeouts', () => {
  const result: ExecResult = {
    code: null,
    stdout: 'out',
    stderr: 'err',
    timedOut: true,
    timeoutKind: RUNNER_IDLE_TIMEOUT_KIND,
  };
  const policy: RunnerTimeoutPolicy = { idleTimeoutMs: 123, wallClockLimitMs: 456 };

  const err = runnerTimeoutFailure('runner', result, undefined, policy);

  assert.equal(err.failureKind, RUNNER_IDLE_TIMEOUT_KIND);
  assert.equal(err.timing?.idleTimeoutMs, 123);
  assert.equal(err.timing?.wallClockLimitMs, 456);
  assert.equal(err.timing?.elapsedMs, 123);
  assert.equal(err.timing?.idleMs, 123);
  assert.match(err.message, /elapsed 123ms, idle 123ms/);
});

test('runner common: fallback timeout evidence keeps wall-clock values for wall-clock limits', () => {
  const result: ExecResult = {
    code: null,
    stdout: '',
    stderr: '',
    timedOut: true,
    timeoutKind: RUNNER_WALL_CLOCK_LIMIT_KIND,
  };
  const policy: RunnerTimeoutPolicy = { idleTimeoutMs: 123, wallClockLimitMs: 456 };

  const err = runnerTimeoutFailure('runner', result, undefined, policy);

  assert.equal(err.failureKind, RUNNER_WALL_CLOCK_LIMIT_KIND);
  assert.equal(err.timing?.elapsedMs, 456);
  assert.equal(err.timing?.idleMs, 456);
});
