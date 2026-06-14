/**
 * run.test.ts — unit tests for `run start` and `run create` (guard + option-mapping).
 *
 * Uses runStartCore (C1 pattern) and createRunCore with fake deps so no NestJS context
 * or real database is needed. Covers the EXACT production code paths for:
 *
 * runStartCore private compatibility seam:
 *   - default options     → runnerMode='script'
 *   - test stub option    → runnerMode='script'
 *   - test live option    → runnerMode='live' AND LIVE_COST_WARNING emitted
 *   - contradictory test options → exitCode=1, startDevelopTask NOT called
 *   - run not found       → exitCode=1, startDevelopTask NOT called
 *   - live warning ordering
 *   - --wait / no --wait  → wait threaded to pollState
 *
 * createRunCore:
 *   - --start without app → exitCode=1, createRunFn NOT called, runStart NOT called
 *   - contradictory test options → exitCode=1, createRunFn NOT called, runStart NOT called
 *   - --start + app (valid) → run created once, runStart called exactly once with {stub,live,wait}
 *   - --start --wait      → wait:true threaded into runStart
 *   - non-start create    → run created, runStart NOT called
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { runStartCore, type RunStartDeps, createRunCore, type CreateRunDeps, registerRun } from './run.js';
import { LIVE_COST_WARNING } from '../live-guard.js';
import type { PollOpts } from './poll-workflow-state.js';
import type { INestApplicationContext } from '@nestjs/common';

// ─── helpers ──────────────────────────────────────────────────────────────────

const FAKE_RUN_ID = 'run-test-001';

type StartDepsOverride = Partial<RunStartDeps>;

type CallRecord = {
  startDevelopTaskCalls: Array<{ runId: string; opts: { runnerMode: 'script' | 'live' } }>;
  pollStateCalls: Array<{ runId: string; pollOpts?: PollOpts }>;
};

test('public run CLI help exposes create-run params without runner override flags', () => {
  const program = new Command();
  registerRun(program);
  const run = program.commands.find((command) => command.name() === 'run');
  assert.ok(run);
  const start = run.commands.find((command) => command.name() === 'start');
  const create = run.commands.find((command) => command.name() === 'create');
  assert.ok(start);
  assert.ok(create);
  const help = `${start.helpInformation()}\n${create.helpInformation()}`;
  assert.equal(help.includes('--stub'), false);
  assert.equal(help.includes('--live'), false);
  assert.equal(help.includes('--params'), true);
  assert.equal(help.includes('--pipeline-id'), true);
});

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
    pollState: async (runId, pollOpts) => {
      record.pollStateCalls.push({ runId, pollOpts });
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

test('runStartCore private compatibility: default options forward runnerMode=script', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false }, deps);
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'script', 'default → script');
    assert.equal(record.startDevelopTaskCalls[0]?.runId, FAKE_RUN_ID, 'runId forwarded');
    assert.equal(record.pollStateCalls.length, 1, 'pollState must be called once');
    assert.equal(record.pollStateCalls[0]?.runId, FAKE_RUN_ID, 'pollState runId forwarded');
    assert.equal(record.pollStateCalls[0]?.pollOpts?.wait, false, 'wait:false by default');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('runStartCore private compatibility: stub option forwards runnerMode=script', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: true, live: false }, deps);
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'script', 'stub test option → script');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('runStartCore private compatibility: live option forwards runnerMode=live and warns before startDevelopTask', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const { warns } = await withConsoleSpy(async () => {
      await runStartCore(FAKE_RUN_ID, { stub: false, live: true }, deps);
    });
    assert.equal(record.startDevelopTaskCalls.length, 1, 'startDevelopTask must be called once');
    assert.equal(record.startDevelopTaskCalls[0]?.opts.runnerMode, 'live', 'live test option → live');
    assert.ok(
      warns.some((w) => w === LIVE_COST_WARNING),
      `LIVE_COST_WARNING must be emitted; got: ${JSON.stringify(warns)}`,
    );
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── guard tests ──────────────────────────────────────────────────────────────

test('runStartCore private compatibility: contradictory runner options set exitCode and do not start', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const { errors } = await withConsoleSpy(async () => {
    await runStartCore(FAKE_RUN_ID, { stub: true, live: true }, deps);
  });
  try {
    assert.equal(process.exitCode, 1, 'exitCode must be 1 on contradictory runner test options');
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

test('runStartCore private compatibility: live warning emitted before startDevelopTask', async () => {
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

// ─── 0006: --wait threading ────────────────────────────────────────────────────

test('run start --wait → pollState receives {wait:true}', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false, wait: true }, deps);
    assert.equal(record.pollStateCalls.length, 1, 'pollState must be called once');
    assert.equal(record.pollStateCalls[0]?.pollOpts?.wait, true, '--wait must set wait:true in PollOpts');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start (no --wait) → pollState receives {wait:false}', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false, wait: false }, deps);
    assert.equal(record.pollStateCalls.length, 1, 'pollState must be called once');
    assert.equal(record.pollStateCalls[0]?.pollOpts?.wait, false, 'no --wait must set wait:false in PollOpts');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run start --wait (no wait field) → pollState receives wait:false by default', async () => {
  const { deps, record } = buildFakeDeps({});
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    // Omit wait field (as if old callers pass {stub, live} only)
    await runStartCore(FAKE_RUN_ID, { stub: false, live: false }, deps);
    assert.equal(record.pollStateCalls.length, 1);
    // wait defaults to false when not provided
    assert.equal(record.pollStateCalls[0]?.pollOpts?.wait, false, 'missing wait defaults to false');
  } finally {
    process.exitCode = origExitCode as number | undefined;
  }
});

// ─── createRunCore tests (B+C: pre-validation before write) ──────────────────

/** Fake INestApplicationContext — only identity matters; methods unused in tests. */
const FAKE_APP = {} as unknown as INestApplicationContext;

type CreateRecord = {
  createRunCalls: number;
  createRunInputs: unknown[];
  runStartCalls: Array<{ runId: string; opts: { stub: boolean; live: boolean; wait: boolean } }>;
};

function buildCreateDeps(opts: {
  app?: INestApplicationContext;
  runId?: string;
}): { deps: CreateRunDeps; record: CreateRecord } {
  const record: CreateRecord = { createRunCalls: 0, createRunInputs: [], runStartCalls: [] };
  const resolvedRunId = opts.runId ?? 'run-create-test-001';

  const deps: CreateRunDeps = {
    createRunFn: async (input) => {
      record.createRunCalls++;
      record.createRunInputs.push(input);
      return {
        runId: resolvedRunId,
        taskId: 'task-create-001',
        stepId: 'step-create-001',
        status: 'ready',
        eventId: 'event-create-001',
      };
    },
    runStart: async (runId, startOpts) => {
      record.runStartCalls.push({ runId, opts: startOpts });
    },
    app: opts.app,
  };

  return { deps, record };
}

function buildCreateOptions(overrides: Partial<{
  title: string; repo: string; description?: string; scope?: string;
  playbookId: string; pipelineId: string; params: string;
  priority: string; role: string; start: boolean; wait: boolean; stub: boolean; live: boolean;
}>): Parameters<typeof createRunCore>[0] {
  return {
    title: 'Test run',
    repo: 'test/repo',
    playbookId: undefined,
    pipelineId: undefined,
    params: undefined,
    priority: '0',
    role: 'architect',
    start: false,
    wait: false,
    stub: false,
    live: false,
    ...overrides,
  };
}

test('run create --start without app → host-required error + exitCode=1 + createRunFn NOT called + runStart NOT called', async () => {
  const { deps, record } = buildCreateDeps({ app: undefined });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  try {
    await createRunCore(buildCreateOptions({ start: true }), deps);
    assert.equal(process.exitCode, 1, 'exitCode must be 1 when app is absent');
    assert.equal(record.createRunCalls, 0, 'createRunFn must NOT be called — no orphan draft');
    assert.equal(record.runStartCalls.length, 0, 'runStart must NOT be called');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('host')),
      `error must mention host context; got: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('createRunCore forwards public route fields and parsed params to createRunFn', async () => {
  const { deps, record } = buildCreateDeps({ app: undefined });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const origLog = console.log;
  console.log = () => undefined;
  try {
    await createRunCore(buildCreateOptions({
      start: false,
      playbookId: 'pb',
      pipelineId: 'feature-development',
      params: '{"ticket":"ABC-1","count":2}',
    }), deps);

    assert.equal(record.createRunCalls, 1);
    assert.deepEqual(record.createRunInputs[0], {
      title: 'Test run',
      repo: 'test/repo',
      description: undefined,
      scope: undefined,
      playbookId: 'pb',
      pipelineId: 'feature-development',
      params: { ticket: 'ABC-1', count: 2 },
      priority: 0,
      role: 'architect',
    });
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('createRunCore rejects non-object params before creating a draft', async () => {
  const { deps, record } = buildCreateDeps({ app: undefined });

  await assert.rejects(
    () => createRunCore(buildCreateOptions({ params: '["not","object"]' }), deps),
    /Invalid --params: expected a JSON object/,
  );
  assert.equal(record.createRunCalls, 0, 'invalid params must not create a run');
});

test('createRunCore private compatibility: contradictory runner options do not create an orphan draft', async () => {
  const { deps, record } = buildCreateDeps({ app: FAKE_APP });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  try {
    await createRunCore(buildCreateOptions({ start: true, stub: true, live: true }), deps);
    assert.equal(process.exitCode, 1, 'exitCode must be 1 on contradictory runner test options');
    assert.equal(record.createRunCalls, 0, 'createRunFn must NOT be called — no orphan draft');
    assert.equal(record.runStartCalls.length, 0, 'runStart must NOT be called');
    assert.ok(
      errors.some((e) => e.toLowerCase().includes('either')),
      `error must mention choose-one; got: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = origError;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run create --start + app (valid) → run created once, runStart called exactly once with private compatibility opts', async () => {
  const { deps, record } = buildCreateDeps({ app: FAKE_APP });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(String(args[0])); };
  try {
    await createRunCore(buildCreateOptions({ start: true, stub: true, live: false, wait: false }), deps);
    assert.equal(record.createRunCalls, 1, 'createRunFn must be called exactly once');
    assert.equal(record.runStartCalls.length, 1, 'runStart must be called exactly once');
    assert.deepEqual(
      record.runStartCalls[0]?.opts,
      { stub: true, live: false, wait: false },
      'runStart must receive the correct {stub, live, wait} flags',
    );
    assert.ok(
      logs.some((l) => l.includes('run-create-test-001')),
      `created run ID must be printed; got: ${JSON.stringify(logs)}`,
    );
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run create --start --wait → wait:true threaded into runStart', async () => {
  const { deps, record } = buildCreateDeps({ app: FAKE_APP });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const origLog = console.log;
  console.log = () => undefined;
  try {
    await createRunCore(buildCreateOptions({ start: true, wait: true }), deps);
    assert.equal(record.runStartCalls.length, 1, 'runStart must be called once');
    assert.equal(record.runStartCalls[0]?.opts.wait, true, '--wait must be threaded into runStart');
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode as number | undefined;
  }
});

test('run create (non-start) → run created, runStart NOT called', async () => {
  const { deps, record } = buildCreateDeps({ app: undefined });
  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  const origLog = console.log;
  console.log = () => undefined;
  try {
    await createRunCore(buildCreateOptions({ start: false }), deps);
    assert.equal(record.createRunCalls, 1, 'createRunFn must be called once');
    assert.equal(record.runStartCalls.length, 0, 'runStart must NOT be called in non-start mode');
    // exitCode must remain unset (success)
    assert.notEqual(process.exitCode, 1, 'exitCode must not be 1 for a successful non-start create');
  } finally {
    console.log = origLog;
    process.exitCode = origExitCode as number | undefined;
  }
});
