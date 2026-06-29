import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactStore } from './artifact-store.js';
import { createCodexRunner } from './codex-runner.js';
import {
  RUNNER_WALL_CLOCK_LIMIT_KIND,
  type ExecRequest,
  type ExecResult,
  type ProcessExecutor,
} from './process-executor.js';
import { RunAgentError } from './runner.js';
import { BASE_STEP, makeRole } from './test-fixtures.js';
import type { ModelProfile } from '../control-plane/definitions.js';
import type { AgentActivityReporter } from '../observability/agent-activity-reporter.js';
import type { RunnerActivityKind, RunnerActivityTracker } from '../observability/activity-signal.js';

const ATTEMPT_ID = 'attempt_20260101T000000000Z_abc12345';

const PROFILE: ModelProfile = {
  level: 'standard',
  provider: 'openai',
  modelId: 'gpt-5-codex',
  params: {},
  costPerInput: 2,
  costPerOutput: 8,
};

type CapturedReporterEvent =
  | { kind: 'started' }
  | { kind: 'spawned'; pid: number }
  | { kind: 'output'; stream: 'stdout' | 'stderr'; chunk: string }
  | { kind: 'parsed'; type?: string; preview?: string }
  | { kind: 'status'; status: string; preview?: string }
  | { kind: 'finished'; exitCode?: number | null; timedOut?: boolean }
  | { kind: 'failed'; message: string; exitCode?: number | null; timedOut?: boolean };

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

function finalResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'approved',
    output: 'done',
    artifacts: null,
    nextSteps: [],
    needsHuman: false,
    lesson: null,
    ...overrides,
  };
}

function jsonl(...events: Record<string, unknown>[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

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

function fakeExecutor(result: ExecResult, captured: ExecRequest[]): ProcessExecutor {
  return async (req) => {
    captured.push(req);
    return result;
  };
}

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
      role: 'developer',
      runner: 'codex',
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

function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'revo-codex-runner-'));
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }));
}

async function runWith(
  executor: ProcessExecutor,
  root: string,
  roleOverrides: Parameters<typeof makeRole>[1] = {},
  profile: ModelProfile = PROFILE,
  reporter?: AgentActivityReporter,
  acceptedVerdicts?: readonly string[],
) {
  const runner = createCodexRunner({
    executor,
    resolveCwd: async () => '/workspace/repo',
    artifactStore: createArtifactStore(root),
    timeoutMs: 5_000,
  });
  return runner({
    role: makeRole('developer', { runner: 'codex', rights: 'write', ...roleOverrides }),
    profile,
    context: '## Role: developer\nDo the thing.',
    attemptId: ATTEMPT_ID,
    step: BASE_STEP,
    reporter,
    acceptedVerdicts,
  });
}

test('codex runner: builds documented codex exec invocation and writes schema file', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await runWith(fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured), root);

    const req = captured[0];
    assert.ok(req, 'executor must be called once');
    assert.equal(req.command, 'codex');
    assert.deepEqual(req.args.slice(0, 4), ['exec', '--json', '--output-schema', req.args[3]]);
    assert.deepEqual(
      req.args.slice(req.args.indexOf('-c'), req.args.indexOf('-c') + 2),
      ['-c', 'approval_policy="never"'],
    );
    assert.deepEqual(req.args.slice(req.args.indexOf('--model'), req.args.indexOf('--model') + 2), ['--model', 'gpt-5-codex']);
    assert.deepEqual(req.args.slice(req.args.indexOf('--sandbox'), req.args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
    assert.deepEqual(req.args.slice(req.args.indexOf('--cd'), req.args.indexOf('--cd') + 2), ['--cd', '/workspace/repo']);
    assert.equal(req.args.at(-1), '-', 'prompt is read from stdin');
    assert.equal(req.args.includes('--profile'), false, '--profile is forbidden');
    assert.equal(req.args.includes('--output-last-message'), false, '--output-last-message is forbidden');
    assert.match(req.input ?? '', /Attempt-Id:/);
    assert.match(req.input ?? '', new RegExp(ATTEMPT_ID));

    const schemaPath = req.args[3] ?? '';
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(schema.required, ['verdict', 'output', 'artifacts', 'nextSteps', 'needsHuman', 'lesson']);
    assert.equal(schema.additionalProperties, false);
    const verdictProp = (schema.properties as Record<string, unknown>).verdict as Record<string, unknown>;
    assert.equal('enum' in verdictProp, false, 'no enum when acceptedVerdicts not provided');
  });
});

test('codex runner: writes schema with verdict.enum equal to acceptedVerdicts', async () => {
  await withTempRoot(async (root) => {
    const domain = ['approved', 'blocker'];
    const captured: ExecRequest[] = [];
    await runWith(
      fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
      root,
      {},
      PROFILE,
      undefined,
      domain,
    );

    const req = captured[0];
    const schemaPath = req?.args[3] ?? '';
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    const verdictProp = (schema.properties as Record<string, unknown>).verdict as Record<string, unknown>;
    assert.deepEqual(verdictProp.enum, domain);
    assert.match(req?.input ?? '', /approved.*blocker|blocker.*approved/);
  });
});

test('codex runner: single-element domain produces single-value enum in written schema', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await runWith(
      fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
      root,
      {},
      PROFILE,
      undefined,
      ['approved'],
    );

    const req = captured[0];
    const schemaPath = req?.args[3] ?? '';
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    const verdictProp = (schema.properties as Record<string, unknown>).verdict as Record<string, unknown>;
    assert.deepEqual(verdictProp.enum, ['approved']);
  });
});

test('codex runner: maps read-only role policy to read-only sandbox', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await runWith(
      fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
      root,
      { rights: 'read-only', allowedTools: ['Read'] },
    );

    const req = captured[0];
    const idx = req?.args.indexOf('--sandbox') ?? -1;
    assert.equal(req?.args[idx + 1], 'read-only');
  });
});

test('codex runner: role.timeoutMs maps to wall-clock cap only', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await runWith(
      fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
      root,
      { timeoutMs: 1_234_567 },
    );

    assert.equal(captured[0]?.timeoutMs, 1_234_567);
    assert.equal(captured[0]?.idleTimeoutMs, 600_000);
  });
});

test('codex runner: env wall-clock override wins over role.timeoutMs in request and artifact metadata', async () => {
  await withTimeoutEnv({ REVO_RUNNER_WALL_CLOCK_LIMIT_MS: '7000' }, async () => {
    await withTempRoot(async (root) => {
      const captured: ExecRequest[] = [];
      await runWith(
        fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
        root,
        { timeoutMs: 1_234 },
      );

      const meta = JSON.parse(
        readFileSync(join(root, BASE_STEP.runId, ATTEMPT_ID, 'meta.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(captured[0]?.timeoutMs, 7_000);
      assert.equal(captured[0]?.idleTimeoutMs, 600_000);
      assert.equal(meta.timeoutMs, 7_000);
      assert.equal(meta.wallClockLimitMs, 7_000);
      assert.equal(meta.idleTimeoutMs, 600_000);
    });
  });
});

test('codex runner: maps explicit write tools to workspace-write even when rights are read-only', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await runWith(
      fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
      root,
      { rights: 'read-only', allowedTools: ['Read', 'Write'] },
    );

    const req = captured[0];
    const idx = req?.args.indexOf('--sandbox') ?? -1;
    assert.equal(req?.args[idx + 1], 'workspace-write');
  });
});

test('codex runner: keeps deploy-read and qa-live style rights read-only', async () => {
  await withTempRoot(async (root) => {
    for (const rights of ['deploy-read', 'qa-live']) {
      const captured: ExecRequest[] = [];
      await runWith(
        fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
        root,
        { rights, allowedTools: ['Read'] },
      );

      const req = captured[0];
      const idx = req?.args.indexOf('--sandbox') ?? -1;
      assert.equal(req?.args[idx + 1], 'read-only', `${rights} must not imply write access`);
    }
  });
});

test('codex runner: fails fast on unknown rights labels instead of granting write access', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult() })), captured),
          root,
          { rights: 'mystery-live-admin', allowedTools: ['Read'] },
        ),
      /does not know how to map role rights "mystery-live-admin" to a sandbox/,
    );
    assert.equal(captured.length, 0, 'executor must not be called when policy mapping is unknown');
  });
});

test('codex runner: fails fast on incompatible provider or missing model before spawn', async () => {
  await withTempRoot(async (root) => {
    const captured: ExecRequest[] = [];
    await assert.rejects(
      () => runWith(fakeExecutor(ok(''), captured), root, {}, { ...PROFILE, provider: 'anthropic' }),
      /OpenAI\/Codex-compatible provider/,
    );
    await assert.rejects(
      () => runWith(fakeExecutor(ok(''), captured), root, {}, { ...PROFILE, modelId: '' }),
      /non-empty model_profiles\.model_id/,
    );
    assert.equal(captured.length, 0, 'executor must not be called');
  });
});

test('codex runner: parses strict structured final result from JSON text in final JSONL item', async () => {
  await withTempRoot(async (root) => {
    const stdout = jsonl(
      { type: 'agent_message', message: 'working' },
      {
        type: 'turn.completed',
        item: {
          content: [{ type: 'output_text', text: JSON.stringify(finalResult({ output: { ok: true }, artifacts: { path: 'a' } })) }],
        },
        usage: { input_tokens: 100, output_tokens: 25 },
      },
    );

    const result = await runWith(fakeExecutor(ok(stdout), []), root);
    assert.equal(result.verdict, 'approved');
    assert.deepEqual(result.output, { ok: true });
    assert.deepEqual(result.artifacts, {
      path: 'a',
      process: { ref: `${BASE_STEP.runId}/${ATTEMPT_ID}`, stdoutTail: '', stderrTail: '' },
    });
    assert.equal(result.needsHuman, false);
    assert.equal(result.costs[0]?.inputTokens, 100);
    assert.equal(result.costs[0]?.outputTokens, 25);
    assert.equal(result.costs[0]?.costAmount, 0.0004);
  });
});

test('codex runner: current JSONL fixtures mark parsed events as activity without unsafe operation state', async () => {
  await withTempRoot(async (root) => {
    const stdout = jsonl(
      { type: 'agent_message', message: 'working' },
      { type: 'turn.completed', output: finalResult() },
    );
    const activityCalls: string[] = [];
    const streamingExecutor: ProcessExecutor = async (req) => {
      req.onActivityTracker?.(trackingActivity(activityCalls));
      req.onStdoutChunk?.(stdout);
      return ok(stdout);
    };

    await runWith(streamingExecutor, root);

    assert.deepEqual(activityCalls, ['activity:event', 'activity:event']);
  });
});

test('codex runner: prefers nested content over nested result in final JSONL item', async () => {
  await withTempRoot(async (root) => {
    const stdout = jsonl({
      type: 'turn.completed',
      item: {
        result: finalResult({ output: 'nested result must be ignored' }),
        content: [{ type: 'output_text', text: JSON.stringify(finalResult({ output: 'nested content wins' })) }],
      },
    });

    const result = await runWith(fakeExecutor(ok(stdout), []), root);
    assert.equal(result.output, 'nested content wins');
  });
});

test('codex runner: rejects malformed JSONL and missing or invalid structured output', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () => runWith(fakeExecutor(ok('not-json\n'), []), root),
      /malformed JSONL/,
    );
    await assert.rejects(
      () => runWith(fakeExecutor(ok(jsonl({ type: 'turn.completed', text: 'plain prose only' })), []), root),
      /missing final schema output/,
    );
    await assert.rejects(
      () => runWith(fakeExecutor(ok(jsonl({ type: 'turn.completed', output: { ...finalResult(), nextSteps: {} } })), []), root),
      /nextSteps must be an array or null/,
    );
    await assert.rejects(
      () => runWith(fakeExecutor(ok(jsonl({ type: 'turn.completed', output: finalResult({ nextSteps: ['bad'] }) })), []), root),
      /nextSteps\[0\] must be an object/,
    );
  });
});

test('codex runner: ignores non-terminal structured JSONL events when final result is missing', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor(
            ok(jsonl(
              { type: 'agent_message', output: finalResult({ output: 'intermediate must not count' }) },
              { type: 'turn.completed', text: 'plain final text only' },
            )),
            [],
          ),
          root,
        ),
      /missing final schema output/,
    );
  });
});

test('codex runner: rejects final schema output with disallowed extra properties', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor(
            ok(jsonl(
              { type: 'agent_message', output: finalResult({ output: 'intermediate must not count' }) },
              { type: 'turn.completed', output: finalResult({ extra: 'not in schema' }) },
            )),
            [],
          ),
          root,
        ),
      /violates output schema: .*\.extra is not allowed by schema/,
    );
  });
});

test('codex runner: stderr is diagnostic and nonfatal on successful structured output', async () => {
  await withTempRoot(async (root) => {
    const events: CapturedReporterEvent[] = [];
    const runnerResult = ok(jsonl({ type: 'turn.completed', output: finalResult({ output: 'ok' }) }), {
      stderr: 'warning from codex',
    });
    const result = await runWith(
      async (req) => {
        req.onStderrChunk?.('warning from codex');
        return runnerResult;
      },
      root,
      {},
      PROFILE,
      capturingReporter(events),
    );

    assert.equal(result.output, 'ok');
    assert.ok(events.some((event) => event.kind === 'output' && event.stream === 'stderr'));
    assert.equal(events.some((event) => event.kind === 'failed'), false);
  });
});

test('codex runner: reports lifecycle, streamed parsed events, and process artifact tails', async () => {
  await withTempRoot(async (root) => {
    const events: CapturedReporterEvent[] = [];
    const stdout = jsonl({ type: 'turn.completed', output: finalResult({ artifacts: { keep: true } }) });
    const result = await runWith(
      async (req) => {
        req.onSpawn?.(123);
        req.onStdoutChunk?.(stdout);
        req.onStderrChunk?.('diagnostic');
        return ok(stdout, { stderr: 'diagnostic' });
      },
      root,
      {},
      PROFILE,
      capturingReporter(events),
    );

    assert.deepEqual(result.artifacts, {
      keep: true,
      process: {
        ref: `${BASE_STEP.runId}/${ATTEMPT_ID}`,
        stdoutTail: stdout,
        stderrTail: 'diagnostic',
      },
    });
    assert.deepEqual(events.map((event) => event.kind), ['started', 'spawned', 'output', 'parsed', 'output', 'finished']);
  });
});

test('codex runner: maps turn.failed permission denial to permission_blocked without failed overwrite', async () => {
  await withTempRoot(async (root) => {
    const events: CapturedReporterEvent[] = [];
    const stdout = jsonl({ type: 'turn.failed', error: { message: 'sandbox denied write access' } });

    await assert.rejects(
      () => runWith(fakeExecutor(ok(stdout), []), root, {}, PROFILE, capturingReporter(events)),
      /turn\.failed/,
    );

    assert.equal(events.at(-1)?.kind, 'status');
    assert.equal((events.at(-1) as Extract<CapturedReporterEvent, { kind: 'status' }> | undefined)?.status, 'permission_blocked');
    assert.equal(events.some((event) => event.kind === 'failed'), false);
  });
});

test('codex runner: maps timeout to timed_out and other failures to failed', async () => {
  await withTempRoot(async (root) => {
    const timeoutEvents: CapturedReporterEvent[] = [];
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor(timeoutResult(), []),
          root,
          {},
          PROFILE,
          capturingReporter(timeoutEvents),
        ),
      /runner-wall-clock-limit/,
    );
    assert.deepEqual(timeoutEvents.at(-1), {
      kind: 'failed',
      message: 'codex runner runner-wall-clock-limit: elapsed 5000ms, idle 5000ms, in-flight operations 0',
      exitCode: null,
      timedOut: true,
    });

    const failedEvents: CapturedReporterEvent[] = [];
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor({ code: 1, stdout: '', stderr: 'auth required', timedOut: false }, []),
          root,
          {},
          PROFILE,
          capturingReporter(failedEvents),
        ),
      /auth required/,
    );
    assert.equal(failedEvents.at(-1)?.kind, 'failed');
  });
});

test('codex runner: process failure permission text maps to permission_blocked', async () => {
  await withTempRoot(async (root) => {
    const events: CapturedReporterEvent[] = [];
    await assert.rejects(
      () =>
        runWith(
          fakeExecutor({ code: 1, stdout: '', stderr: 'approval denied by policy', timedOut: false }, []),
          root,
          {},
          PROFILE,
          capturingReporter(events),
        ),
      /approval denied by policy/,
    );
    assert.equal(events.at(-1)?.kind, 'status');
    assert.equal((events.at(-1) as Extract<CapturedReporterEvent, { kind: 'status' }> | undefined)?.status, 'permission_blocked');
  });
});

test('codex runner: needsHuman returns true and drops nextSteps', async () => {
  await withTempRoot(async (root) => {
    const result = await runWith(
      fakeExecutor(
        ok(jsonl({
          type: 'turn.completed',
          output: finalResult({
            verdict: 'blocker',
            needsHuman: true,
            nextSteps: [{ role: 'developer', kind: 'implement', input: null }],
            lesson: 'blocked',
          }),
        })),
        [],
      ),
      root,
    );
    assert.equal(result.needsHuman, true);
    assert.equal(result.nextSteps.length, 0);
    assert.equal(result.lesson, 'blocked');
  });
});

test('codex runner: non-zero exit error carries process artifact refs and tails', async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      () =>
        runWith(
          async (req) => {
            req.onStderrChunk?.('auth required');
            return { code: 1, stdout: '', stderr: 'auth required', timedOut: false };
          },
          root,
        ),
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
  });
});
