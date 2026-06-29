import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeCodeRunner } from './claude-code-runner.js';
import {
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  type ExecRequest,
  type ExecResult,
  type ProcessExecutor,
} from './process-executor.js';
import { createArtifactStore } from './artifact-store.js';
import { RunAgentError } from './runner.js';
import { makeRole, BASE_STEP } from './test-fixtures.js';
import type { ModelProfile } from '../control-plane/definitions.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import type { RunnerActivityKind, RunnerActivityTracker } from '../observability/activity-signal.js';

// Fake executor: records the ExecRequest and returns a canned ExecResult. No real `claude`, no tokens.
function fakeExecutor(result: ExecResult, captured: ExecRequest[]): ProcessExecutor {
  return async (req) => {
    captured.push(req);
    return result;
  };
}

const PROFILE: ModelProfile = {
  level: 'standard',
  provider: 'anthropic',
  modelId: 'claude-sonnet-4-6',
  params: {},
  costPerInput: 3,
  costPerOutput: 15,
};

function ok(stdout: string, extra: Partial<ExecResult> = {}): ExecResult {
  return { code: 0, stdout, stderr: '', timedOut: false, ...extra };
}

function timeoutResult(extra: Partial<ExecResult> = {}): ExecResult {
  return {
    code: null,
    stdout: '',
    stderr: '',
    timedOut: true,
    timeoutKind: RUNNER_WALL_CLOCK_LIMIT_KIND,
    timeoutEvidence: {
      idleTimeoutMs: 600_000,
      wallClockLimitMs: 5_000,
      elapsedMs: 5_000,
      idleMs: 5_000,
      lastActivityAt: new Date(0).toISOString(),
      inFlightOperationCount: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      eventCount: 0,
    },
    ...extra,
  };
}

function transport(resultText: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result: resultText,
    total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
    ...extra,
  });
}

function agentBlock(obj: unknown): string {
  return `Here is the result.\n<<<REVO_RESULT\n${JSON.stringify(obj)}\nREVO_RESULT>>>\n`;
}

function structuredTransport(
  structured: Record<string, unknown> | undefined = { verdict: 'approved', output: 'ok' },
  extraTransport: Record<string, unknown> = {},
): string {
  return transport('ignored prose', { ...extraTransport, structured_output: structured ?? { verdict: 'approved', output: 'ok' } });
}

const ATTEMPT_ID = 'attempt_20260101T000000000Z_abc12345';

async function withTimeoutEnv<T>(
  env: Partial<Pick<NodeJS.ProcessEnv, 'REVO_RUNNER_IDLE_TIMEOUT_MS' | 'REVO_RUNNER_WALL_CLOCK_LIMIT_MS'>>,
  fn: () => Promise<T>,
): Promise<T> {
  const priorIdle = process.env['REVO_RUNNER_IDLE_TIMEOUT_MS'];
  const priorWall = process.env['REVO_RUNNER_WALL_CLOCK_LIMIT_MS'];
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    if (priorIdle === undefined) delete process.env['REVO_RUNNER_IDLE_TIMEOUT_MS'];
    else process.env['REVO_RUNNER_IDLE_TIMEOUT_MS'] = priorIdle;
    if (priorWall === undefined) delete process.env['REVO_RUNNER_WALL_CLOCK_LIMIT_MS'];
    else process.env['REVO_RUNNER_WALL_CLOCK_LIMIT_MS'] = priorWall;
  }
}

function fakeReporter(events: string[]): AgentActivityReporter {
  return {
    started: () => { events.push('started'); },
    spawned: (pid) => { events.push(`spawned:${pid}`); },
    output: (stream, chunk) => { events.push(`${stream}:${chunk}`); },
    parsed: (event) => { events.push(`parsed:${event.type ?? ''}`); },
    status: (status) => { events.push(`status:${status}`); },
    finished: (event) => { events.push(`finished:${String(event.exitCode)}:${String(event.timedOut)}`); },
    failed: (error) => { events.push(`failed:${error instanceof Error ? error.message : String(error)}`); },
    flush: async () => undefined,
    snapshot: () => ({
      runId: BASE_STEP.runId,
      attemptId: ATTEMPT_ID,
      stepId: BASE_STEP.id,
      role: 'architect',
      runner: 'claude-code',
      status: 'running',
      startedAt: new Date(0).toISOString(),
      lastEventAt: new Date(0).toISOString(),
      stdoutBytes: 0,
      stderrBytes: 0,
      eventCount: 0,
      artifactRef: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
    }),
  };
}

type CapturedReporterEvent =
  | { kind: 'started' }
  | { kind: 'spawned'; pid: number }
  | { kind: 'output'; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'parsed'; type?: string; preview?: string }
  | { kind: 'status'; status: string; preview?: string }
  | { kind: 'finished'; exitCode?: number | null; timedOut?: boolean }
  | { kind: 'failed'; message: string; exitCode?: number | null; timedOut?: boolean };

function capturingReporter(events: CapturedReporterEvent[]): AgentActivityReporter {
  return {
    started: () => { events.push({ kind: 'started' }); },
    spawned: (pid) => { events.push({ kind: 'spawned', pid }); },
    output: (stream, chunk) => { events.push({ kind: 'output', stream, chunk }); },
    parsed: (event) => { events.push({ kind: 'parsed', type: event.type, preview: event.preview }); },
    status: (status, detail) => { events.push({ kind: 'status', status, preview: detail?.preview }); },
    finished: (event) => { events.push({ kind: 'finished', exitCode: event.exitCode, timedOut: event.timedOut }); },
    failed: (error, detail) => {
      events.push({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
        exitCode: detail?.exitCode,
        timedOut: detail?.timedOut,
      });
    },
    flush: async () => undefined,
    snapshot: () => ({
      runId: BASE_STEP.runId,
      attemptId: ATTEMPT_ID,
      stepId: BASE_STEP.id,
      role: 'architect',
      runner: 'claude-code',
      status: 'running',
      startedAt: new Date(0).toISOString(),
      lastEventAt: new Date(0).toISOString(),
      stdoutBytes: 0,
      stderrBytes: 0,
      eventCount: 0,
      artifactRef: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
    }),
  };
}

function trackingActivity(calls: string[]): RunnerActivityTracker {
  return {
    markActivity: (kind: RunnerActivityKind) => { calls.push(`activity:${kind}`); },
    recordOutput: (stream, bytes) => { calls.push(`output:${stream}:${bytes}`); },
    operationStarted: (id) => { calls.push(`start:${id}`); },
    operationFinished: (id) => { calls.push(`finish:${id}`); },
    snapshot: () => ({
      startedAt: 0,
      lastActivityAt: 0,
      inFlightOperationCount: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      eventCount: 0,
    }),
  };
}

function run(executor: ProcessExecutor, roleOverrides = {}) {
  const runner = createClaudeCodeRunner({
    executor,
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });
  return runner({
    role: makeRole('architect', roleOverrides),
    profile: PROFILE,
    context: '## Role: architect\nDo the thing.',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
}

// ─── command build ────────────────────────────────────────────────────────────

test('claude-code runner: builds the documented claude -p invocation', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured));

  const req = captured[0];
  assert.ok(req, 'executor must be called once');
  assert.equal(req?.command, 'claude');
  assert.ok(req?.args.includes('-p'), 'args include -p');
  assert.ok(req?.args.includes('--permission-mode'), 'args include --permission-mode');
  assert.deepEqual(
    req?.args.slice(req.args.indexOf('--model'), req.args.indexOf('--model') + 2),
    ['--model', 'claude-sonnet-4-6'],
    'args include --model <profile.modelId>',
  );
  assert.deepEqual(
    req?.args.slice(req.args.indexOf('--output-format'), req.args.indexOf('--output-format') + 2),
    ['--output-format', 'stream-json'],
    'args include --output-format stream-json (incremental transcript)',
  );
  assert.ok(req?.args.includes('--verbose'), 'stream-json requires --verbose in -p mode');
  assert.equal(req?.cwd, '/workspace/repo', 'cwd comes from resolveCwd');
  assert.ok(req?.input?.includes(ATTEMPT_ID), 'prompt delivered on stdin includes the attemptId');
});

test('claude-code runner: stream-json — reports a per-turn transcript and extracts the terminal result', async () => {
  // JSONL as claude emits over stream-json: system/assistant/tool turns, then a terminal `result`.
  const streamLines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading files' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result' }] } }),
    structuredTransport({ verdict: 'approved', output: 'done' }),
  ];
  const fullStdout = streamLines.join('\n') + '\n';
  // Feed in two chunks, splitting line 3 mid-way to exercise the partial-line buffer.
  const splitAt = streamLines.slice(0, 2).join('\n').length + 1 + 10;
  const streamingExecutor: ProcessExecutor = async (req) => {
    req.onStdoutChunk?.(fullStdout.slice(0, splitAt));
    req.onStdoutChunk?.(fullStdout.slice(splitAt));
    return ok(fullStdout);
  };

  const events: CapturedReporterEvent[] = [];
  const runner = createClaudeCodeRunner({ executor: streamingExecutor, resolveCwd: async () => '/workspace/repo', timeoutMs: 5_000 });
  const result = await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter: capturingReporter(events),
  });

  // verdict/output extracted from the terminal result line of the stream
  assert.equal(result.verdict, 'approved', 'verdict comes from the stream terminal result');
  assert.equal(result.output, 'done');

  // per-turn transcript reported as parsed events (NOT the terminal result line — reported separately)
  const parsed = events.filter((e): e is Extract<CapturedReporterEvent, { kind: 'parsed' }> => e.kind === 'parsed');
  const types = parsed.map((e) => e.type);
  assert.ok(types.includes('assistant'), 'assistant turns are reported');
  assert.ok(types.includes('user'), 'tool_result turn is reported');
  assert.ok(
    parsed.some((e) => e.preview?.includes('[tool_use:Edit]')),
    'tool_use preview names the tool',
  );
});

test('claude-code runner: stream-json maps stable tool_use/tool_result IDs to generic operations', async () => {
  const streamLines = [
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read' }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }],
      },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Edit' }],
      },
    }),
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'missing-tool' }],
      },
    }),
    structuredTransport({ verdict: 'approved', output: 'done' }),
  ];
  const fullStdout = streamLines.join('\n') + '\n';
  const activityCalls: string[] = [];
  const streamingExecutor: ProcessExecutor = async (req) => {
    req.onActivityTracker?.(trackingActivity(activityCalls));
    req.onStdoutChunk?.(fullStdout);
    return ok(fullStdout);
  };

  const runner = createClaudeCodeRunner({
    executor: streamingExecutor,
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });

  assert.deepEqual(
    activityCalls.filter((call) => call.startsWith('start:') || call.startsWith('finish:')),
    ['start:toolu_1', 'finish:toolu_1', 'finish:missing-tool'],
  );
  assert.equal(activityCalls.filter((call) => call === 'activity:event').length, 5);
  assert.equal(activityCalls.includes('start:undefined'), false);
});

test('claude-code runner: no allowed-tools flag when role.allowedTools is empty', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured), { allowedTools: [] });

  assert.ok(!captured[0]?.args.includes('--allowedTools'), 'empty allowedTools → no tools flag');
});

test('claude-code runner: maps role.allowedTools to the allowed-tools flag', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured), { allowedTools: ['Edit', 'Write'] });

  const req = captured[0];
  const idx = req?.args.indexOf('--allowedTools') ?? -1;
  assert.ok(idx >= 0, 'allowed-tools flag present');
  assert.equal(req?.args[idx + 1], 'Edit,Write', 'tools joined and never widened beyond the list');
});

// ─── 0008 #5: per-role timeout / permission_mode + model params ───────────────

test('claude-code runner (0008 #5): uses role.permissionMode (not the hardcoded default)', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(stdout), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('developer', { permissionMode: 'acceptEdits' }),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
  const req = captured[0];
  const idx = req?.args.indexOf('--permission-mode') ?? -1;
  assert.equal(req?.args[idx + 1], 'acceptEdits', 'permission mode must come from the role');
});

test('claude-code runner (0008 #5): defaults permission mode to "default" when role omits it', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured));
  const req = captured[0];
  const idx = req?.args.indexOf('--permission-mode') ?? -1;
  assert.equal(req?.args[idx + 1], 'default');
});

test('claude-code runner (0008 #5): role.timeoutMs maps to wall-clock cap only', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(stdout), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('architect', { timeoutMs: 1_234_567 }),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
  assert.equal(captured[0]?.timeoutMs, 1_234_567, 'per-role timeout must set the wall-clock cap');
  assert.equal(captured[0]?.idleTimeoutMs, 600_000, 'idle timeout remains separate from role.timeoutMs');
});

test('claude-code runner (0008 #5): absent or zero role.timeoutMs uses the runner wall-clock default', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(stdout), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('architect', { timeoutMs: 0 }),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
  assert.equal(captured[0]?.timeoutMs, 5_000);
  assert.equal(captured[0]?.idleTimeoutMs, 600_000);
});

test('claude-code runner: env wall-clock override wins over role.timeoutMs in request and artifact metadata', async () => {
  await withTimeoutEnv({ REVO_RUNNER_WALL_CLOCK_LIMIT_MS: '7000' }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'revo-runner-env-timeout-'));
    try {
      const captured: ExecRequest[] = [];
      const stdout = structuredTransport();
      const runner = createClaudeCodeRunner({
        executor: fakeExecutor(ok(stdout), captured),
        resolveCwd: async () => '/workspace/repo',
        timeoutMs: 5_000,
        artifactStore: createArtifactStore(root),
      });

      await runner({
        role: makeRole('architect', { timeoutMs: 1_234 }),
        profile: PROFILE,
        context: 'ctx',
        attemptId: ATTEMPT_ID,
        step: BASE_STEP,
      });

      const meta = JSON.parse(
        readFileSync(join(root, BASE_STEP.runId, ATTEMPT_ID, 'meta.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(captured[0]?.timeoutMs, 7_000);
      assert.equal(captured[0]?.idleTimeoutMs, 600_000);
      assert.equal(meta.timeoutMs, 7_000);
      assert.equal(meta.wallClockLimitMs, 7_000);
      assert.equal(meta.idleTimeoutMs, 600_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('claude-code runner (0008 #5): model_profiles.params.maxTurns maps to --max-turns', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(stdout), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('developer'),
    profile: { ...PROFILE, params: { maxTurns: 12 } },
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });
  const req = captured[0];
  const idx = req?.args.indexOf('--max-turns') ?? -1;
  assert.ok(idx >= 0, '--max-turns flag present when params.maxTurns is set');
  assert.equal(req?.args[idx + 1], '12');
});

test('claude-code runner (0008 #5): no --max-turns flag when params is empty', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured));
  assert.ok(!captured[0]?.args.includes('--max-turns'), 'empty params → no --max-turns');
});

// ─── prompt contains the contract (regression guard) ──────────────────────────

test('claude-code runner: constrains output via --json-schema + a structured-result note', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured));

  const args = captured[0]?.args ?? [];
  assert.ok(args.includes('--json-schema'), 'args must pass --json-schema (structured output)');
  const input = captured[0]?.input ?? '';
  assert.ok(/verdict/.test(input), 'prompt must instruct the structured result (verdict field)');
});

test('claude-code runner: advertises ONLY the template accepted verdicts, never a wider global menu', async () => {
  const captured: ExecRequest[] = [];
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(structuredTransport()), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('developer'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    acceptedVerdicts: ['approved'],
  });

  const req = captured[0];
  const schemaIdx = (req?.args.indexOf('--json-schema') ?? -1);
  const schemaText = req?.args[schemaIdx + 1] ?? '';
  const schema = JSON.parse(schemaText) as { properties?: { verdict?: { enum?: unknown; description?: string } } };
  assert.deepEqual(schema.properties?.verdict?.enum, ['approved'], 'schema enum must match the template domain');
  assert.match(schema.properties?.verdict?.description ?? '', /approved/, 'schema verdict description names the accepted token');
  assert.doesNotMatch(schemaText, /clean/, 'schema must NOT advertise out-of-domain "clean"');
  assert.doesNotMatch(schemaText, /dirty/, 'schema must NOT advertise out-of-domain "dirty"');

  const prompt = req?.input ?? '';
  assert.match(prompt, /approved/, 'prompt note names the accepted token');
  assert.doesNotMatch(prompt, /clean/, 'prompt note must NOT advertise out-of-domain "clean"');
  assert.doesNotMatch(prompt, /dirty/, 'prompt note must NOT advertise out-of-domain "dirty"');
});

test('claude-code runner: advertises every accepted verdict for a multi-token domain', async () => {
  const captured: ExecRequest[] = [];
  const runner = createClaudeCodeRunner({ executor: fakeExecutor(ok(structuredTransport()), captured), resolveCwd: async () => '/w', timeoutMs: 5_000 });
  await runner({
    role: makeRole('reviewer'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    acceptedVerdicts: ['approved', 'changes_requested', 'blocker'],
  });

  const req = captured[0];
  const schemaText = req?.args[(req?.args.indexOf('--json-schema') ?? -1) + 1] ?? '';
  const schema = JSON.parse(schemaText) as { properties?: { verdict?: { enum?: unknown } } };
  assert.deepEqual(schema.properties?.verdict?.enum, ['approved', 'changes_requested', 'blocker']);
  for (const token of ['approved', 'changes_requested', 'blocker']) {
    assert.match(schemaText, new RegExp(token), `schema advertises ${token}`);
  }
});

test('claude-code runner: falls back to the global verdict menu when no domain is supplied', async () => {
  const captured: ExecRequest[] = [];
  await run(fakeExecutor(ok(structuredTransport()), captured));
  const req = captured[0];
  const schemaText = req?.args[(req?.args.indexOf('--json-schema') ?? -1) + 1] ?? '';
  const schema = JSON.parse(schemaText) as { properties?: { verdict?: { enum?: unknown } } };
  assert.equal(schema.properties?.verdict?.enum, undefined, 'fallback must not add a fake enum when domain is unknown');
  assert.match(schemaText, /approved/, 'fallback still names verdict tokens so the field is described');
  assert.match(schemaText, /clean/, 'fallback retains the historical global menu when domain is unknown');
});

test('claude-code runner: reads verdict + output from --json-schema structured_output', async () => {
  const stdout = structuredTransport({ verdict: 'approved', output: 'the plan' });
  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.verdict, 'approved', 'verdict comes from the validated structured_output');
  assert.equal(result.output, 'the plan');
});

test('claude-code runner: rejects prose REVO_RESULT when structured_output is absent', async () => {
  const stdout = transport(agentBlock({ verdict: 'blocker', output: 'x', nextSteps: [], needsHuman: false }));
  await assert.rejects(
    () => run(fakeExecutor(ok(stdout), [])),
    /missing structured_output/,
  );
});

// ─── envelope parse → AttemptResult ───────────────────────────────────────────

test('claude-code runner: parses the envelope into output/artifacts/nextSteps/costs', async () => {
  const stdout = structuredTransport({
    verdict: 'approved',
    output: 'planned',
    artifacts: { planPath: 'docs/plans/0099.md' },
    nextSteps: [{ role: 'developer', kind: 'implement', input: { from: 'step-1' } }],
    needsHuman: false,
    lesson: null,
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.output, 'planned');
  assert.deepEqual(result.artifacts, { planPath: 'docs/plans/0099.md' });
  assert.equal(result.nextSteps.length, 1);
  assert.equal(result.nextSteps[0]?.role, 'developer');
  assert.equal(result.nextSteps[0]?.taskId, BASE_STEP.taskId, 'taskId defaulted from step');
  assert.equal(result.needsHuman, false);
  assert.equal(result.costs.length, 1);
  assert.equal(result.costs[0]?.costAmount, 0.01, 'prefers CLI-reported USD');
  assert.equal(result.costs[0]?.inputTokens, 100);
  assert.equal(result.costs[0]?.modelProfile, BASE_STEP.modelProfile);
});

test('claude-code runner: writes process artifacts and returns a stable process ref/tails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-runner-artifacts-'));
  try {
    const stdout = structuredTransport({
      verdict: 'approved',
      output: 'planned',
      artifacts: { planPath: 'docs/plans/0099.md' },
      nextSteps: [],
      needsHuman: false,
    });
    const runner = createClaudeCodeRunner({
      executor: async (req) => {
        req.onStdoutChunk?.('transport stdout tail');
        req.onStderrChunk?.('debug stderr tail');
        return ok(stdout, { stderr: 'debug stderr tail' });
      },
      resolveCwd: async () => '/workspace/repo',
      timeoutMs: 5_000,
      artifactStore: createArtifactStore(root),
    });

    const result = await runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
    });

    assert.deepEqual(result.artifacts, {
      planPath: 'docs/plans/0099.md',
      process: {
        ref: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
        stdoutTail: 'transport stdout tail',
        stderrTail: 'debug stderr tail',
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude-code runner: reports spawn, stdout, stderr, parsed, and finished lifecycle', async () => {
  const events: string[] = [];
  const stdout = structuredTransport({ verdict: 'approved', output: 'ok' });
  const runner = createClaudeCodeRunner({
    executor: async (req) => {
      req.onSpawn?.(456);
      // stream-json: a stdout line is parsed into a per-turn `parsed` event (not a raw stdout event).
      req.onStdoutChunk?.('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n');
      req.onStderrChunk?.('diagnostic chunk');
      return ok(stdout, { stderr: 'diagnostic chunk' });
    },
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter: fakeReporter(events),
  });

  assert.deepEqual(events, [
    'started',
    'spawned:456',
    'parsed:assistant',
    'stderr:diagnostic chunk',
    'parsed:result',
    'parsed:usage',
    'finished:0:false',
  ]);
});

test('claude-code runner: reports Claude final JSON metadata as parsed events', async () => {
  const events: CapturedReporterEvent[] = [];
  const stdout = structuredTransport(
    { verdict: 'approved', output: 'ok', artifacts: { keep: true }, nextSteps: [], needsHuman: false },
    {
      session_id: 'session-123',
      terminal_reason: 'permission_denied',
      permission_denials: [{ tool_name: 'Write', reason: 'not allowed' }],
    },
  );
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  const result = await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter: capturingReporter(events),
  });

  assert.equal(result.output, 'ok', 'AttemptResult output still comes from structured_output');
  assert.deepEqual(result.artifacts, { keep: true }, 'agent artifacts are preserved');
  const parsedTypes = events
    .filter((event): event is Extract<CapturedReporterEvent, { kind: 'parsed' }> => event.kind === 'parsed')
    .map((event) => event.type);
  assert.deepEqual(parsedTypes, ['result', 'usage', 'session_id', 'terminal_reason', 'permission_denials']);
  const usageEvent = events.find(
    (event): event is Extract<CapturedReporterEvent, { kind: 'parsed' }> =>
      event.kind === 'parsed' && event.type === 'usage',
  );
  assert.match(usageEvent?.preview ?? '', /total_cost_usd/);
  const permissionEvent = events.find(
    (event): event is Extract<CapturedReporterEvent, { kind: 'parsed' }> =>
      event.kind === 'parsed' && event.type === 'permission_denials',
  );
  assert.match(permissionEvent?.preview ?? '', /Write/);
});

test('claude-code runner: does not report finished when AttemptResult construction fails', async () => {
  const events: CapturedReporterEvent[] = [];
  const stdout = structuredTransport({
    verdict: 'approved',
    output: 'ok',
    nextSteps: ['bad'],
    needsHuman: false,
  });
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await assert.rejects(
    () =>
      runner({
        role: makeRole('architect'),
        profile: PROFILE,
        context: 'ctx',
        attemptId: ATTEMPT_ID,
        step: BASE_STEP,
        reporter: capturingReporter(events),
      }),
    /agent result nextSteps\[0\] is not an object/,
  );

  assert.equal(events.some((event) => event.kind === 'finished'), false);
  assert.deepEqual(events.at(-1), {
    kind: 'failed',
    message: 'agent result nextSteps[0] is not an object',
    exitCode: undefined,
    timedOut: undefined,
  });
});

test('claude-code runner: reports is_error metadata before failing the attempt', async () => {
  const events: CapturedReporterEvent[] = [];
  const stdout = JSON.stringify({ is_error: true, result: 'model refused' });
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await assert.rejects(() =>
    runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
      reporter: capturingReporter(events),
    }),
  );

  assert.deepEqual(events.slice(-2), [
    { kind: 'parsed', type: 'is_error', preview: '{"is_error":true}' },
    { kind: 'failed', message: 'claude-code runner reported is_error: model refused', exitCode: 0, timedOut: undefined },
  ]);
});

test('claude-code runner: clean exit with permission_denials reports terminal permission_blocked', async () => {
  const events: CapturedReporterEvent[] = [];
  const stdout = structuredTransport(
    { verdict: 'approved', output: 'ok', nextSteps: [], needsHuman: false },
    { permission_denials: [{ tool_name: 'Edit', reason: 'denied by policy' }] },
  );
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  const result = await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter: capturingReporter(events),
  });

  assert.equal(result.output, 'ok');
  assert.equal(result.verdict, 'approved');
  assert.equal(result.needsHuman, false);
  assert.equal(result.nextSteps.length, 0);
  assert.deepEqual(events.at(-2), { kind: 'finished', exitCode: 0, timedOut: false });
  assert.equal(events.at(-1)?.kind, 'status');
  assert.equal((events.at(-1) as Extract<CapturedReporterEvent, { kind: 'status' }> | undefined)?.status, 'permission_blocked');
});

test('claude-code runner: permission_denials parsed preview is bounded', async () => {
  const events: CapturedReporterEvent[] = [];
  const denials = Array.from({ length: 8 }, (_value, index) => ({
    tool_name: `Tool${index}`,
    reason: 'x'.repeat(2_000),
  }));
  const stdout = structuredTransport(
    { verdict: 'approved', output: 'ok', nextSteps: [], needsHuman: false },
    { permission_denials: denials },
  );
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok(stdout), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter: capturingReporter(events),
  });

  const permissionEvent = events.find(
    (event): event is Extract<CapturedReporterEvent, { kind: 'parsed' }> =>
      event.kind === 'parsed' && event.type === 'permission_denials',
  );
  assert.ok((permissionEvent?.preview?.length ?? 0) <= 1_003, 'runner bounds metadata before reporter redaction');
  assert.match(permissionEvent?.preview ?? '', /\[3 more\]/);
});

test('claude-code runner: reported total_cost_usd of 0 with non-zero tokens yields cost 0 (not token-computed)', async () => {
  const stdout = structuredTransport(undefined, {
    total_cost_usd: 0,
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.costs.length, 1, 'a reported $0 with tokens → one cost record');
  assert.equal(result.costs[0]?.costAmount, 0, 'reported $0 is honored, not overridden by token-computed amount');
});

test('claude-code runner: computes cost from tokens when no USD is reported', async () => {
  const stdout = structuredTransport(undefined, {
    total_cost_usd: undefined,
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  // 1e6/1e6*3 + 1e6/1e6*15 = 18
  assert.equal(result.costs[0]?.costAmount, 18);
});

test('claude-code runner: zero tokens and no USD → empty costs', async () => {
  const stdout = structuredTransport(undefined, {
    total_cost_usd: undefined,
    usage: { input_tokens: 0, output_tokens: 0 },
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.costs.length, 0);
});

// ─── timeout ──────────────────────────────────────────────────────────────────

test('claude-code runner: throws on timeout (mentions the timeout)', async () => {
  await assert.rejects(
    () => run(fakeExecutor(timeoutResult(), [])),
    /runner-wall-clock-limit/,
  );
});

test('claude-code runner: reports timed_out lifecycle on timeout', async () => {
  const events: CapturedReporterEvent[] = [];
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(timeoutResult(), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await assert.rejects(() =>
    runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
      reporter: capturingReporter(events),
    }),
  );

  assert.deepEqual(events, [
    { kind: 'started' },
    {
      kind: 'failed',
      message: 'claude-code runner runner-wall-clock-limit: elapsed 5000ms, idle 5000ms, in-flight operations 0',
      exitCode: null,
      timedOut: true,
    },
  ]);
});

// ─── error → lesson ─────────────────────────────────────────────────────────

test('claude-code runner: non-zero exit throws with stderr as the lesson', async () => {
  await assert.rejects(
    () => run(fakeExecutor({ code: 1, stdout: '', stderr: 'auth required', timedOut: false }, [])),
    /auth required/,
  );
});

test('claude-code runner: reports failed lifecycle on non-zero exit', async () => {
  const events: string[] = [];
  const runner = createClaudeCodeRunner({
    executor: async () => ({ code: 2, stdout: '', stderr: 'auth required', timedOut: false }),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await assert.rejects(() =>
    runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
      reporter: fakeReporter(events),
    }),
  );

  assert.deepEqual(events, ['started', 'failed:claude-code runner exited with code 2']);
});

test('claude-code runner: non-zero exit error carries process artifact refs/tails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-runner-artifacts-'));
  try {
    const runner = createClaudeCodeRunner({
      executor: async (req) => {
        req.onStderrChunk?.('auth required');
        return { code: 1, stdout: '', stderr: 'auth required', timedOut: false };
      },
      resolveCwd: async () => '/workspace/repo',
      timeoutMs: 5_000,
      artifactStore: createArtifactStore(root),
    });

    await assert.rejects(
      () =>
        runner({
          role: makeRole('architect'),
          profile: PROFILE,
          context: 'ctx',
          attemptId: ATTEMPT_ID,
          step: BASE_STEP,
        }),
      (err) => {
        assert.ok(err instanceof RunAgentError);
        assert.deepEqual(err.artifacts, {
          agent: null,
          process: {
            ref: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
            stdoutTail: '',
            stderrTail: 'auth required',
          },
        });
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude-code runner: is_error transport throws with the text as the lesson', async () => {
  const stdout = JSON.stringify({ is_error: true, result: 'model refused' });
  await assert.rejects(
    () => run(fakeExecutor(ok(stdout), [])),
    /model refused/,
  );
});

test('claude-code runner: non-JSON stdout throws the transport lesson', async () => {
  await assert.rejects(
    () => run(fakeExecutor(ok('this is not json'), [])),
    /transport envelope/,
  );
});

test('claude-code runner: reports failed lifecycle on malformed final JSON', async () => {
  const events: CapturedReporterEvent[] = [];
  const runner = createClaudeCodeRunner({
    executor: fakeExecutor(ok('this is not json'), []),
    resolveCwd: async () => '/workspace/repo',
    timeoutMs: 5_000,
  });

  await assert.rejects(() =>
    runner({
      role: makeRole('architect'),
      profile: PROFILE,
      context: 'ctx',
      attemptId: ATTEMPT_ID,
      step: BASE_STEP,
      reporter: capturingReporter(events),
    }),
  );

  assert.deepEqual(events, [
    { kind: 'started' },
    {
      kind: 'failed',
      // stream-json: stdout with no terminal `result` line fails at extraction, before envelope parse.
      message: 'claude -p stream contained no result event (transport envelope)',
      exitCode: undefined,
      timedOut: undefined,
    },
  ]);
});

test('claude-code runner: missing structured_output throws the structured result lesson', async () => {
  const stdout = transport('I did the work but forgot the block.');
  await assert.rejects(
    () => run(fakeExecutor(ok(stdout), [])),
    /missing structured_output/,
  );
});

test('claude-code runner: invalid structured_output carries process artifact refs/tails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'revo-runner-artifacts-'));
  try {
    const stdout = structuredTransport({ verdict: '', output: 'plan' });
    const runner = createClaudeCodeRunner({
      executor: async (req) => {
        req.onStdoutChunk?.('bad structured output');
        return ok(stdout);
      },
      resolveCwd: async () => '/workspace/repo',
      timeoutMs: 5_000,
      artifactStore: createArtifactStore(root),
    });

    await assert.rejects(
      () =>
        runner({
          role: makeRole('architect'),
          profile: PROFILE,
          context: 'ctx',
          attemptId: ATTEMPT_ID,
          step: BASE_STEP,
        }),
      (err) => {
        assert.ok(err instanceof RunAgentError);
        assert.match(err.message, /missing required top-level verdict/);
        assert.deepEqual(err.artifacts, {
          agent: null,
          process: {
            ref: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
            stdoutTail: 'bad structured output',
            stderrTail: '',
          },
        });
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── needsHuman ────────────────────────────────────────────────────────────

test('claude-code runner: needsHuman returns true and drops nextSteps', async () => {
  const stdout = structuredTransport({
    verdict: 'blocker',
    output: 'approve?',
    // agent erroneously included a nextStep — runner must drop it on needsHuman
    nextSteps: [{ role: 'developer', kind: 'implement', input: null }],
    needsHuman: true,
    lesson: 'blocked on approval',
  });

  const result = await run(fakeExecutor(ok(stdout), []));
  assert.equal(result.needsHuman, true);
  assert.equal(result.verdict, 'blocker');
  assert.equal(result.nextSteps.length, 0, 'needsHuman drops nextSteps');
  assert.equal(result.lesson, 'blocked on approval');
});

// ─── idempotency / no external calls beyond the executor ──────────────────────

test('claude-code runner: threads attemptId into the prompt and calls only the executor', async () => {
  const captured: ExecRequest[] = [];
  let resolveCwdCalls = 0;
  let executorCalls = 0;
  const stdout = structuredTransport();

  const runner = createClaudeCodeRunner({
    executor: async (req) => {
      executorCalls++;
      captured.push(req);
      return ok(stdout);
    },
    resolveCwd: async () => {
      resolveCwdCalls++;
      return '/workspace/x';
    },
    timeoutMs: 5_000,
  });

  await runner({
    role: makeRole('architect'),
    profile: PROFILE,
    context: 'ctx',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
  });

  assert.ok(captured[0]?.input?.includes(ATTEMPT_ID), 'attemptId present in delivered prompt');
  assert.equal(executorCalls, 1, 'process launched exactly once via the executor');
  assert.equal(resolveCwdCalls, 1, 'no external call beyond executor + injected resolveCwd');
});

test('claude-code runner: reports failed lifecycle when resolveCwd rejects before process start', async () => {
  const events: string[] = [];
  let executorCalls = 0;
  const runner = createClaudeCodeRunner({
    executor: async () => {
      executorCalls++;
      return ok(structuredTransport());
    },
    resolveCwd: async () => {
      throw new Error('worktree unavailable');
    },
    timeoutMs: 5_000,
  });

  await assert.rejects(
    () =>
      runner({
        role: makeRole('architect'),
        profile: PROFILE,
        context: 'ctx',
        attemptId: ATTEMPT_ID,
        step: BASE_STEP,
        reporter: fakeReporter(events),
      }),
    (err) => {
      assert.ok(err instanceof RunAgentError);
      assert.match(err.message, /worktree unavailable/);
      assert.equal(err.artifacts, undefined);
      return true;
    },
  );

  assert.equal(executorCalls, 0, 'process must not launch when cwd resolution fails');
  assert.deepEqual(events, ['failed:worktree unavailable']);
});

// ─── defaults ──────────────────────────────────────────────────────────────

test('claude-code runner: defaults command to "claude"', async () => {
  const captured: ExecRequest[] = [];
  const stdout = structuredTransport();
  await run(fakeExecutor(ok(stdout), captured));
  assert.equal(captured[0]?.command, 'claude');
});

// NOTE: per-STEP worktree lifecycle was removed in plan 0017 — the runner no longer owns worktree
// create/release. Per-RUN worktree isolation is owned by the workflow adapter (see
// data-driven-task.workflow.ts) and covered by git-worktree-manager.test.ts + the concurrency e2e.

// ─── slice-143 follow-up: REVO_WORKTREE_PATH env + worktree note ──────────────

test('claude-code runner (slice-143): REVO_WORKTREE_PATH set and prompt includes worktree note for a linked worktree', async () => {
  // A linked worktree's .git is a FILE (gitdir: pointer), not a directory.
  const root = mkdtempSync(join(tmpdir(), 'revo-wt-'));
  try {
    writeFileSync(join(root, '.git'), 'gitdir: /some/other/repo/.git/worktrees/x\n');
    const captured: ExecRequest[] = [];
    const runner = createClaudeCodeRunner({
      executor: fakeExecutor(ok(structuredTransport()), captured),
      resolveCwd: async () => root,
      timeoutMs: 5_000,
    });
    await runner({ role: makeRole('developer'), profile: PROFILE, context: 'ctx', attemptId: ATTEMPT_ID, step: BASE_STEP });
    const req = captured[0];
    assert.equal(req?.env?.REVO_WORKTREE_PATH, root, 'REVO_WORKTREE_PATH must equal the worktree cwd');
    assert.ok(req?.input?.includes('REVO_WORKTREE_PATH'), 'prompt must mention $REVO_WORKTREE_PATH');
    assert.ok(req?.input?.includes(root), 'prompt must include the worktree path');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude-code runner (slice-143): no REVO_WORKTREE_PATH and no worktree note for a non-worktree cwd', async () => {
  // /workspace/repo does not exist on disk, so isWorktreeDir returns false.
  const captured: ExecRequest[] = [];
  await run(fakeExecutor(ok(structuredTransport()), captured));
  assert.equal(captured[0]?.env, undefined, 'env must be undefined for a non-worktree cwd');
  assert.ok(!captured[0]?.input?.includes('REVO_WORKTREE_PATH'), 'prompt must NOT include REVO_WORKTREE_PATH for non-worktree cwd');
});
