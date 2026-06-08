/**
 * run.test.ts — unit tests for the run start command (guard + option-mapping).
 *
 * Uses the exported runStartCore (C1 pattern) with fake RunStartDeps so no NestJS
 * context or real database is needed. Exercises the EXACT production code path for:
 *   - default (no flags)  → runnerMode='script'
 *   - --stub              → runnerMode='script'
 *   - --live              → runnerMode='live' AND LIVE_COST_WARNING emitted
 *   - --stub --live       → process.exitCode===1, startDevelopTask NOT called
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runStartCore, type RunStartDeps } from './run.js';
import { LIVE_COST_WARNING } from '../live-guard.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const FAKE_RUN_ID = 'run-test-001';

type StartDepsOverride = Partial<RunStartDeps>;

type CallRecord = {
  startDevelopTaskCalls: Array<{ runId: string; opts: { runnerMode: 'script' | 'live' } }>;
  pollStateCalls: string[];
};

/**
 * Build fake deps for runStartCore. Returns the deps + a call record for assertions.
 * runFound: whether getRun returns a row (default: true).
 * existingStatus: what getWorkflowStatus returns (default: null = not started).
 */
function buildFakeDeps(opts: {
  runFound?: boolean;
  existingStatus?: { status: string } | null;
  overrides?: StartDepsOverride;
}): { deps: RunStartDeps; record: CallRecord } {
  const record: CallRecord = {
    startDevelopTaskCalls: [],
    pollStateCalls: [],
  };

  const deps: RunStartDeps = {
    getRun: async (runId) => {
      if (opts.runFound === false) return null;
      return { rowId: runId, data: { title: 'Test run' } };
    },
    getWorkflowStatus: async (_id) => opts.existingStatus ?? null,
    startDevelopTask: async (runId, startOpts) => {
      record.startDevelopTaskCalls.push({ runId, opts: startOpts });
      return { workflowID: runId };
    },
    pollState: async (runId) => {
      record.pollStateCalls.push(runId);
    },
    ...opts.overrides,
  };

  return { deps, record };
}

/** Capture console.warn/error calls and restore after the callback. */
async function withConsoleSpy<T>(fn: () => Promise<T>): Promise<{ result: T; warns: string[]; errors: string[] }> {
  const warns: string[] = [];
  const errors: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args: unknown[]) => { warns.push(String(args[0])); };
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  try {
    const result = await fn();
    return { result, warns, errors };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

// ─── option-mapping tests ──────────────────────────────────────────────────────

test('run start default (no flags) → runnerMode=script forwarded to startDevelopTask', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false }, deps);
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'script', 'default → script');
    assert.equal(record.startDevelopTaskCalls[0]?.runId, FAKE_RUN_ID, 'runId forwarded');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start --stub → runnerMode=script forwarded to startDevelopTask', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: true, live: false }, deps);
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'script', '--stub → script');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start --live → runnerMode=live AND LIVE_COST_WARNING emitted before startDevelopTask', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const { warns } = await withConsoleSpy(async () => {
      await runStartCore(FAKE_RUN_ID, { stub: false, live: true }, deps);
    });
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'live', '--live → live');
    assert.ok(
      warns.some((w) => w === LIVE_COST_WARNING),
      `LIVE_COST_WARNING must be emitted; got: ${JSON.stringify(warns)}`,
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── guard tests ──────────────────────────────────────────────────────────────

test('run start --stub --live → process.exitCode===1, startDevelopTask NOT called', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const { errors } = await withConsoleSpy(async () => {
    await runStartCore(FAKE_RUN_ID, { stub: true, live: true }, deps);
  });
  try {
    assert.equal(process.exitCode, 1, 'exitCode must be 1 on --stub --live contradiction');
    assert.equal(record.startDevelopTaskCalls.length, 0, 'startDevelopTask must NOT be called');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('either')),
      `error must mention choose-one; got: ${JSON.stringify(errors)}`,
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start: run not found → process.exitCode===1, startDevelopTask NOT called', async () => {
  const { deps, record } = buildFakeDeps({ runFound: false });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const { errors } = await withConsoleSpy(async () => {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false }, deps);
  });
  try {
    assert.equal(process.exitCode, 1, 'exitCode must be 1 when run not found');
    assert.equal(record.startDevelopTaskCalls.length, 0, 'startDevelopTask must NOT be called');
    assert.ok(
      errors.some((e) => e.includes('not found')),
      `error must mention not found; got: ${JSON.stringify(errors)}`,
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start --live: WARNING emitted BEFORE startDevelopTask (ordering)', async () => {
  // Ensure warnLiveCost fires before startDevelopTask is called.
  const callOrder: string[] = [];
  const origWarn = console.warn;
  console.warn = (msg: string) => { callOrder.push(`warn:${msg}`); };
  const origExitCode = process.exitCode;
  process.exitCode = undefined;

  const { deps } = buildFakeDeps({
    overrides: {
      startDevelopTask: async (runId, opts) => {
        callOrder.push(`startDevelopTask:${opts.runnerMode}`);
        return { workflowID: runId };
      },
    },
  });

  try {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: true }, deps);
    const warnIdx = callOrder.findIndex((e) => e.startsWith('warn:'));
    const startIdx = callOrder.findIndex((e) => e.startsWith('startDevelopTask:'));
    assert.ok(warnIdx >= 0, 'warning must be emitted');
    assert.ok(startIdx >= 0, 'startDevelopTask must be called');
    assert.ok(warnIdx < startIdx, 'warning must be emitted BEFORE startDevelopTask');
  } finally {
    console.warn = origWarn;
    process.exitCode = origExitCode as number | undefined;
  }
});
