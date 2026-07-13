/**
 * make-run-step.test.ts — unit tests for the SHARED per-step runner seam (`makeRunStep`).
 *
 * `makeRunStep` is the generic step the data-driven engine reuses for every `agent` node (role→runner
 * dispatch + attempt/cost/event bookkeeping). It is exercised through the REAL production builder with
 * fakes (C1) — PipelineService registers exactly this function, so these tests fail if the dispatch,
 * canonical-role loading, event/attempt bookkeeping, or runner-failure handling regresses.
 *
 * (The old hardcoded `developTask` workflow + `verdictOf` were REMOVED in plan 0015 slice 3 — the
 * data-driven engine is the sole pipeline engine; its loop is covered by data-driven-task.workflow.test.ts
 * and the A–L e2e suite. Only the kept `makeRunStep` seam is unit-tested here.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunStep, type RunStepDeps } from './pipeline.service.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';
import { RunAgentError, type AttemptResult, type RunAgent } from '../worker/runner.js';
import { RUNNER_IDLE_TIMEOUT_KIND } from '../worker/process-executor.js';
import type { Role } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { AppendEventInput, AppendCostInput, AppendAttemptInput } from '../run/append-event.js';
import type { AgentOutputEvent } from '../observability/types.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const BINDING: ResolvedAgentBinding = {
  runnerId: 'stub-agent',
  provider: 'test',
  modelId: 'test-model',
  modelParams: {},
  slotKey: 'node:developer',
  nodeId: 'developer',
  roleId: 'developer',
  roleDocumentId: 'role-doc-developer',
  permissionMode: 'read-only',
  permissionSource: 'profile',
  runner: {
    runnerId: 'stub-agent',
    manifestVersion: 'test',
    manifestDigest: `sha256:${'a'.repeat(64)}`,
    stdoutParserId: 'stub',
    permissionStyleId: 'stub',
    declaredDefaultPermissionMode: 'read-only',
    capabilities: {},
    constraints: {},
    executionFields: {},
  },
};

function bindingFor(role: string): ResolvedAgentBinding {
  return {
    ...BINDING,
    slotKey: `role:${role}`,
    nodeId: role,
    roleId: role,
    roleDocumentId: `role-doc-${role}`,
  };
}

function makeRole(name: string): Role {
  return {
    name,
    systemPrompt: `System prompt for ${name}`,
    allowedTools: [],
    scopeRules: {},
  };
}

/** Fake in-memory data-access. */
function makeFakeDa(opts: { throwConflict?: boolean } = {}): { da: ControlPlaneDataAccess } {
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async (table, rowId) =>
      table === 'tasks' ? { rowId, data: { title: 'Test task', scope: 'scope', repo_ref: '' } } : null,
    createRow: async (table, rowId, data) => {
      if (opts.throwConflict) throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      return { rowId, data };
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _p) => ({ rowId, data: {} }),
  };
  return { da };
}

/** loadPipelineContext fake returning an in-memory Step. */
function makeLoadPipelineContext(taskId = 'task-001') {
  const { da } = makeFakeDa();
  return async (
    rId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
  ): Promise<Awaited<ReturnType<RunStepDeps['loadPipelineContext']>>> => {
    const step: Step = {
      id: `pstep_fake_${stepKey}`,
      taskId,
      runId: rId,
      role,
      kind: 'pipeline',
      status: 'running',
      input: stepInput,
      output: null,
      runAfter: '',
      attemptCount: 0,
      maxAttempts: 1,
      priority: 0,
      leaseOwner: '',
      leaseExpiresAt: '',
      deadReason: '',
    };
    return { da, step, runContext: { description: '', params: {} } };
  };
}

type Harness = {
  loadRoleArgs: string[];
  registerArgs: Array<{ runId: string; taskId: string; stepId: string; attemptId: string }>;
  appendEventArgs: AppendEventInput[];
  appendCostInputs: AppendCostInput[];
  appendAttemptInputs: AppendAttemptInput[];
};

/**
 * Build the RunStepDeps the production `makeRunStep` consumes. The `runAgent` is the REAL
 * `createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent })` (cost-safety shape) — a
 * claude-code dispatch in this harness THROWS (no real claude), exactly as PipelineService is wired.
 */
function buildRunStepDeps(opts: { roles?: Map<string, Role> } = {}): {
  deps: RunStepDeps;
  harness: Harness;
  throwingClaudeCode: RunAgent;
} {
  const harness: Harness = { loadRoleArgs: [], registerArgs: [], appendEventArgs: [], appendCostInputs: [], appendAttemptInputs: [] };

  const roles = opts.roles ?? new Map<string, Role>([
    ['role-doc-architect', makeRole('architect')],
    ['role-doc-developer', makeRole('developer')],
    ['role-doc-reviewer', makeRole('reviewer')],
  ]);

  const throwingClaudeCode: RunAgent = async () => {
    throw new Error('RUNNER_NOT_IMPLEMENTED — claude-code runner not wired in this test harness');
  };

  const deps: RunStepDeps = {
    loadRole: async (name: string): Promise<Role> => {
      harness.loadRoleArgs.push(name);
      return roles.get(name) ?? makeRole(name);
    },
    loadPipelineContext: makeLoadPipelineContext(),
    appendEvent: async (input: AppendEventInput): Promise<void> => {
      harness.appendEventArgs.push(input);
    },
    appendCost: async (input: AppendCostInput): Promise<void> => {
      harness.appendCostInputs.push(input);
    },
    appendAttempt: async (input: AppendAttemptInput): Promise<void> => {
      harness.appendAttemptInputs.push(input);
    },
    registerAgentOutputStream: async (input) => {
      harness.registerArgs.push(input);
    },
    runAgent: createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent }),
  };

  return { deps, harness, throwingClaudeCode };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('T1: runStep(architect) writes one step_succeeded event with a pinned role document + bounded id', async () => {
  const runId = 'run-t1';
  const { deps, harness } = buildRunStepDeps();
  const runStep = makeRunStep(deps);

  const result = await runStep(runId, 'architect', 'architect', { phase: 'plan' }, bindingFor('architect'));

  // One step_succeeded event written by the REAL appendEvent fake.
  assert.equal(harness.appendEventArgs.length, 1);
  assert.equal(harness.appendEventArgs[0]?.type, 'step_succeeded');
  assert.equal(harness.appendEventArgs[0]?.stepKey, 'architect');

  // loadRole received the exact document identity (never a `#k` rework suffix).
  assert.equal(harness.loadRoleArgs[0], 'role-doc-architect');
  assert.ok(!harness.loadRoleArgs[0]?.includes('#'), 'loadRole must receive canonical name');

  // Output carries the generic stub echo; the routing verdict is top-level (the stub is role-agnostic).
  const output = result.output as Record<string, unknown>;
  assert.ok(typeof output.echo === 'string' && output.echo.includes('role=architect'));
  assert.equal(output.verdict, undefined);
  assert.equal(result.verdict, 'approved');

  // A bounded, deterministic attempt row was written.
  const attempt = harness.appendAttemptInputs[0];
  assert.ok(attempt?.attemptId.startsWith('attempt_'), 'attemptId must be deterministic + bounded');
  assert.equal(attempt?.status, 'succeeded');
});

test('runStep forwards accepted template verdicts to the runner', async () => {
  const { deps } = buildRunStepDeps();
  let capturedVerdicts: readonly string[] | undefined;
  deps.runAgent = async ({ acceptedVerdicts }): Promise<AttemptResult> => {
    capturedVerdicts = acceptedVerdicts;
    return { output: 'ok', verdict: 'approved', nextSteps: [], costs: [], needsHuman: false };
  };
  const runStep = makeRunStep(deps);

  await runStep(
    'run-verdict-domain',
    'developer',
    'developer',
    { phase: 'implement' },
    BINDING,
    undefined,
    ['approved'],
  );

  assert.deepEqual(capturedVerdicts, ['approved']);
});

test('runner failure → step_failed event + a fail-closed BLOCKER attempt (never a stranded DBOS error)', async () => {
  const runId = 'run-fail';
  const seededRoles = new Map<string, Role>([['role-doc-architect', makeRole('architect')]]);
  const { deps, harness, throwingClaudeCode } = buildRunStepDeps({ roles: seededRoles });
  // A claude-code role + the throwing runner: the runner-process failure becomes a DOMAIN blocking
  // result (needsHuman + BLOCKER attempt), NOT a thrown DBOS step error that strands task_runs=ready.
  deps.runAgent = throwingClaudeCode;
  const runStep = makeRunStep(deps);

  const result = await runStep(runId, 'architect', 'architect', { phase: 'plan' }, bindingFor('architect'));

  assert.equal(result.needsHuman, true, 'a runner crash parks the step (needsHuman)');
  assert.match(result.lesson ?? '', /RUNNER_NOT_IMPLEMENTED/);
  assert.equal((result.output as { verdict?: string }).verdict, 'BLOCKER', 'fail-closed verdict');
  assert.equal(harness.appendEventArgs.at(-1)?.type, 'step_failed');
  assert.equal(harness.appendAttemptInputs.at(-1)?.status, 'failed');
  assert.equal(harness.appendAttemptInputs.at(-1)?.verdict, 'BLOCKER');
});

test('runner failure envelope carries structured timeout classification and timing evidence', async () => {
  const runId = 'run-timeout-envelope';
  const { deps, harness } = buildRunStepDeps();
  const timing = {
    idleTimeoutMs: 600_000,
    wallClockLimitMs: 3_600_000,
    elapsedMs: 650_000,
    idleMs: 600_001,
    lastActivityAt: '2026-06-26T10:00:00.000Z',
    inFlightOperationCount: 0,
    stdoutBytes: 10,
    stderrBytes: 2,
    eventCount: 3,
  };
  deps.runAgent = async () => {
    throw new RunAgentError('claude-code runner runner-idle-timeout', undefined, {
      failureKind: RUNNER_IDLE_TIMEOUT_KIND,
      retryableCandidate: true,
      timing,
    });
  };
  const runStep = makeRunStep(deps);

  const result = await runStep(runId, 'developer', 'developer', { phase: 'implement' }, BINDING);
  const output = result.output as Record<string, unknown>;

  assert.equal(result.needsHuman, true);
  assert.equal(output.error, 'runner_failed');
  assert.equal(output.failureKind, RUNNER_IDLE_TIMEOUT_KIND);
  assert.equal(output.retryableCandidate, true);
  assert.deepEqual(output.timing, timing);
  assert.deepEqual(harness.appendAttemptInputs.at(-1)?.output, output);
});

test('attempt row surfaces the verdict + iteration (from stepKey) + a deterministic attemptId', async () => {
  const runId = 'run-attempt';
  const { deps, harness } = buildRunStepDeps();
  deps.runAgent = async (): Promise<AttemptResult> => ({
    output: '# Plan\nShip it.',
    verdict: 'approved',
    nextSteps: [],
    costs: [{ runnerId: 'stub-agent', provider: 'test', modelId: 'test-model', currency: null, inputTokens: 10, outputTokens: 5, costAmount: null }],
    needsHuman: false,
  });
  const runStep = makeRunStep(deps);

  // A rework stepKey (`developer#2`) → iteration 2, attemptNo 3.
  await runStep(runId, 'developer', 'developer#2', { phase: 'rework' }, BINDING);

  const attempt = harness.appendAttemptInputs[0];
  assert.ok(attempt, 'an attempt row is written');
  assert.equal(attempt.iteration, 2, 'iteration is parsed from the stepKey #k suffix');
  assert.equal(attempt.attemptNo, 3, 'attemptNo is iteration+1');
  assert.equal(attempt.verdict, 'approved', 'the top-level verdict is surfaced on the row');
  assert.equal(attempt.status, 'succeeded');
  assert.ok(attempt.attemptId.startsWith('attempt_'));
  assert.ok((attempt.inputTokens ?? 0) === 10 && (attempt.outputTokens ?? 0) === 5, 'tokens aggregated from costs');
});

test('physical attempt argument scopes attempt row, events, costs, reporter, and runner dispatch', async () => {
  const runId = 'run-physical';
  const { deps, harness } = buildRunStepDeps();
  const physicalAttempt = { attemptNo: 2, attemptId: 'attempt_physical_2' };
  const streamEvents: AgentOutputEvent[] = [];
  let seenAttemptId = '';
  deps.writeAgentOutputEvent = async (event) => {
    streamEvents.push(event);
  };
  deps.runAgent = async ({ attemptId, reporter }): Promise<AttemptResult> => {
    seenAttemptId = attemptId;
    reporter?.started();
    return {
      output: { ok: true },
      verdict: 'approved',
      nextSteps: [],
      costs: [{ runnerId: 'stub-agent', provider: 'test', modelId: 'test-model', inputTokens: 1, outputTokens: 2, costAmount: null, currency: null }],
      needsHuman: false,
    };
  };
  const runStep = makeRunStep(deps);

  await runStep(
    runId,
    'developer',
    'developer',
    { nodeId: 'developer', attempt: physicalAttempt },
    BINDING,
    physicalAttempt,
  );

  const event = harness.appendEventArgs.find((e) => e.type === 'step_succeeded');
  const payload = event?.payload as { attemptId?: string; attemptNo?: number } | undefined;
  assert.equal(seenAttemptId, physicalAttempt.attemptId, 'runner receives the physical attempt id');
  assert.equal(event?.idempotencyKey, physicalAttempt.attemptId, 'event id is scoped by attempt id');
  assert.equal(payload?.attemptId, physicalAttempt.attemptId);
  assert.equal(payload?.attemptNo, physicalAttempt.attemptNo);
  assert.equal(harness.appendCostInputs[0]?.attemptId, physicalAttempt.attemptId, 'cost row points at the attempt');
  assert.equal(harness.appendAttemptInputs[0]?.attemptId, physicalAttempt.attemptId);
  assert.equal(harness.appendAttemptInputs[0]?.attemptNo, physicalAttempt.attemptNo);
  assert.equal(streamEvents[0]?.attemptId, physicalAttempt.attemptId, 'reporter stream is scoped by attempt id');
});

test('attempt row includes the process artifact ref + stdout/stderr tails', async () => {
  const runId = 'run-artifact';
  const { deps, harness } = buildRunStepDeps();
  deps.runAgent = async (): Promise<AttemptResult> => ({
    output: { verdict: 'PASS' },
    artifacts: { process: { ref: `${runId}/attempt_test`, stdoutTail: 'stdout tail', stderrTail: 'stderr tail' } },
    nextSteps: [],
    costs: [],
    needsHuman: false,
  });
  const runStep = makeRunStep(deps);

  await runStep(runId, 'architect', 'architect', { phase: 'plan' }, bindingFor('architect'));

  const attempt = harness.appendAttemptInputs[0];
  assert.equal(attempt?.artifactRef, `${runId}/attempt_test`);
  assert.equal(attempt?.verdict, 'unknown', 'output.verdict is observability-only and is not used');
  assert.equal(attempt?.stdoutTail, 'stdout tail');
  assert.equal(attempt?.stderrTail, 'stderr tail');
});

test('agent activity reporter is scoped to the attempt, streamed, and flushed before runStep returns', async () => {
  const runId = 'run-reporter';
  const { deps } = buildRunStepDeps();
  const streamEvents: AgentOutputEvent[] = [];
  deps.writeAgentOutputEvent = async (event) => {
    streamEvents.push(event);
  };
  deps.runAgent = async ({ reporter }): Promise<AttemptResult> => {
    reporter?.started();
    reporter?.output('stdout', 'hello');
    reporter?.finished({ exitCode: 0, timedOut: false });
    return { output: 'ok', verdict: 'approved', nextSteps: [], costs: [], needsHuman: false };
  };
  const runStep = makeRunStep(deps);

  await runStep(runId, 'developer', 'developer', { phase: 'implement' }, BINDING);

  assert.deepEqual(streamEvents.map((event) => event.kind), ['activity', 'output', 'status']);
  assert.equal(streamEvents[0]?.runId, runId);
  assert.equal(streamEvents[0]?.stepKey, 'developer');
  assert.equal(streamEvents[0]?.snapshot?.runner, 'stub-agent');
  assert.equal(streamEvents[1]?.snapshot?.stdoutBytes, 5);
  assert.equal(streamEvents[2]?.snapshot?.status, 'exited');
});

test('agent activity reporter writer failures do not fail a successful agent step', async () => {
  const { deps, harness } = buildRunStepDeps();
  const origWarn = console.warn;
  console.warn = () => undefined;
  try {
    deps.writeAgentOutputEvent = async () => {
      throw new Error('dbos stream down');
    };
    deps.runAgent = async ({ reporter }): Promise<AttemptResult> => {
      reporter?.started();
      reporter?.output('stdout', 'still succeeds');
      return { output: 'ok', verdict: 'approved', nextSteps: [], costs: [], needsHuman: false };
    };
    const runStep = makeRunStep(deps);

    const result = await runStep('run-reporter-fail', 'developer', 'developer', {}, BINDING);

    assert.equal(result.verdict, 'approved');
    assert.equal(harness.appendEventArgs.at(-1)?.type, 'step_succeeded');
    assert.equal(harness.appendAttemptInputs.at(-1)?.status, 'succeeded');
  } finally {
    console.warn = origWarn;
  }
});

test('params.planPath context error fails before launching the agent', async () => {
  const runId = 'run-context-missing';
  const { deps, harness } = buildRunStepDeps();
  let launched = false;
  deps.loadPipelineContext = async (rId, role, stepKey, stepInput) => {
    const base = await makeLoadPipelineContext()(rId, role, stepKey, stepInput);
    return { ...base, runContext: { description: '', params: { planPath: 'missing.md' } } };
  };
  deps.runAgent = async (): Promise<AttemptResult> => {
    launched = true;
    return { output: 'should not run', verdict: 'approved', nextSteps: [], costs: [], needsHuman: false };
  };
  const runStep = makeRunStep(deps);

  await assert.rejects(
    () => runStep(runId, 'architect', 'architect', { phase: 'plan' }, bindingFor('architect')),
    /revo\.ContextMissing/,
  );

  assert.equal(launched, false, 'agent must not launch without required context');
  assert.equal(harness.appendEventArgs.at(-1)?.type, 'step_failed');
  assert.equal(harness.registerArgs.length, 0, 'stream registration must follow successful context construction');
});

test('stream registration is durable before runner invocation', async () => {
  const { deps, harness } = buildRunStepDeps();
  const order: string[] = [];
  deps.registerAgentOutputStream = async (input) => {
    order.push('register');
    harness.registerArgs.push(input);
  };
  deps.runAgent = async () => {
    order.push('runner');
    return { output: 'ok', verdict: 'approved', nextSteps: [], costs: [], needsHuman: false };
  };
  await makeRunStep(deps)('run-register', 'developer', 'developer', {}, BINDING);
  assert.deepEqual(order, ['register', 'runner']);
  assert.equal(harness.registerArgs[0]?.attemptId.startsWith('attempt_'), true);
});

test('per-role runner threading: a resolved stub runner dispatches via the stub (never the throwing claude-code)', async () => {
  const runId = 'run-thread';
  // The role document is not the runner authority; the pinned binding selects the stub.
  const seededRoles = new Map<string, Role>([['role-doc-developer', makeRole('developer')]]);
  const { deps, harness } = buildRunStepDeps({ roles: seededRoles });
  const runStep = makeRunStep(deps);

  // The pinned stub-agent binding selects the injected test runner (no throw).
  const result = await runStep(runId, 'developer', 'developer', { phase: 'implement' }, BINDING);

  assert.equal(harness.appendEventArgs.at(-1)?.type, 'step_succeeded', 'stub runner succeeds (no claude throw)');
  const output = result.output as Record<string, unknown>;
  assert.ok(typeof output.echo === 'string' && output.echo.includes('role=developer'));
});

test('idempotency: appendEvent ROW_CONFLICT on replay is a no-op (no duplicate write, no throw)', async () => {
  const { da: conflictDa } = makeFakeDa({ throwConflict: true });
  const { appendRunEvent } = await import('../run/append-event.js');
  // The production append catches ROW_CONFLICT and skips — a crashed-then-replayed step is side-effect-free.
  await appendRunEvent(conflictDa, {
    runId: 'run-idm',
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'architect',
    type: 'step_succeeded',
    payload: {},
  });
  // Reaching here (no throw) is the assertion.
});
