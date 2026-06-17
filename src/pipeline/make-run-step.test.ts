/**
 * make-run-step.test.ts — unit tests for the SHARED per-step runner seam (`makeRunStep`).
 *
 * `makeRunStep` is the generic step the data-driven engine reuses for every `agent` node (role→runner
 * dispatch + attempt/cost/event bookkeeping). It is exercised through the REAL production builder with
 * fakes (C1) — PipelineService registers exactly this function, so these tests fail if the dispatch,
 * canonical-role loading, event/attempt bookkeeping, runner-failure handling, or model-profile
 * resolution regresses.
 *
 * (The old hardcoded `developTask` workflow + `verdictOf` were REMOVED in plan 0015 slice 3 — the
 * data-driven engine is the sole pipeline engine; its loop is covered by data-driven-task.workflow.test.ts
 * and the A–L e2e suite. Only the kept `makeRunStep` seam is unit-tested here.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRunStep, type RunStepDeps } from './develop-task.workflow.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';
import type { AttemptResult, RunAgent } from '../worker/runner.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { AppendEventInput, AppendCostInput, AppendAttemptInput } from '../run/append-event.js';
import type { ExecutionProfile } from './route-contract.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeRole(name: string, runner: 'claude-code' | 'script' = 'script'): Role {
  return {
    name,
    systemPrompt: `System prompt for ${name}`,
    modelLevel: name === 'architect' ? 'deep' : 'standard',
    effort: 'high',
    runner,
    allowedTools: [],
    scopeRules: {},
  };
}

function makeProfile(level: 'cheap' | 'standard' | 'deep' = 'standard'): ModelProfile {
  return {
    level,
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-6',
    params: {},
    costPerInput: 3,
    costPerOutput: 15,
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

/** loadPipelineContext fake returning an in-memory Step (records the modelProfile arg). */
function makeLoadPipelineContext(taskId = 'task-001') {
  const { da } = makeFakeDa();
  return async (
    rId: string,
    role: string,
    stepKey: string,
    stepInput: unknown,
    modelProfile: string,
  ): Promise<{ da: ControlPlaneDataAccess; step: Step }> => {
    const step: Step = {
      id: `pstep_fake_${stepKey}`,
      taskId,
      runId: rId,
      role,
      kind: 'pipeline',
      status: 'running',
      input: stepInput,
      output: null,
      modelProfile,
      runAfter: '',
      attemptCount: 0,
      maxAttempts: 1,
      priority: 0,
      leaseOwner: '',
      leaseExpiresAt: '',
      deadReason: '',
    };
    return { da, step };
  };
}

type Harness = {
  loadRoleArgs: string[];
  appendEventArgs: Array<{ stepKey: string; type: string }>;
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
  const harness: Harness = { loadRoleArgs: [], appendEventArgs: [], appendAttemptInputs: [] };

  const roles = opts.roles ?? new Map<string, Role>([
    ['architect', makeRole('architect')],
    ['developer', makeRole('developer')],
    ['reviewer', makeRole('reviewer')],
  ]);

  const throwingClaudeCode: RunAgent = async () => {
    throw new Error('RUNNER_NOT_IMPLEMENTED — claude-code runner not wired in this test harness');
  };

  const deps: RunStepDeps = {
    loadRole: async (name: string): Promise<Role> => {
      harness.loadRoleArgs.push(name);
      return roles.get(name) ?? makeRole(name);
    },
    loadModelProfile: async (level: string): Promise<ModelProfile> =>
      makeProfile(level as 'cheap' | 'standard' | 'deep'),
    loadPipelineContext: makeLoadPipelineContext(),
    appendEvent: async (input: AppendEventInput): Promise<void> => {
      harness.appendEventArgs.push({ stepKey: input.stepKey, type: input.type });
    },
    appendCost: async (_input: AppendCostInput): Promise<void> => undefined,
    appendAttempt: async (input: AppendAttemptInput): Promise<void> => {
      harness.appendAttemptInputs.push(input);
    },
    runAgent: createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent }),
  };

  return { deps, harness, throwingClaudeCode };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('T1: runStep(architect) writes one step_succeeded event with a canonical loadRole + bounded id', async () => {
  const runId = 'run-t1';
  const { deps, harness } = buildRunStepDeps();
  const runStep = makeRunStep(deps);

  const result = await runStep(runId, 'architect', 'architect', { phase: 'plan' }, 'script');

  // One step_succeeded event written by the REAL appendEvent fake.
  assert.equal(harness.appendEventArgs.length, 1);
  assert.equal(harness.appendEventArgs[0]?.type, 'step_succeeded');
  assert.equal(harness.appendEventArgs[0]?.stepKey, 'architect');

  // loadRole received the CANONICAL name (never a `#k` rework suffix).
  assert.equal(harness.loadRoleArgs[0], 'architect');
  assert.ok(!harness.loadRoleArgs[0]?.includes('#'), 'loadRole must receive canonical name');

  // Output carries the generic stub echo + a passing verdict (the stub is role-agnostic, slice 4).
  const output = result.output as Record<string, unknown>;
  assert.ok(typeof output.echo === 'string' && output.echo.includes('role=architect'));
  assert.equal(output.verdict, 'PASS');

  // A bounded, deterministic attempt row was written.
  const attempt = harness.appendAttemptInputs[0];
  assert.ok(attempt?.attemptId.startsWith('attempt_'), 'attemptId must be deterministic + bounded');
  assert.equal(attempt?.status, 'succeeded');
});

test('B7: the model profile is resolved from role.modelLevel (architect=deep), not hardcoded', async () => {
  const runId = 'run-b7';
  const { deps, harness } = buildRunStepDeps();
  let capturedModelProfile = '';
  const origLoadPipelineContext = deps.loadPipelineContext;
  deps.loadPipelineContext = async (rId, role, stepKey, stepInput, modelProfile) => {
    if (role === 'architect') capturedModelProfile = modelProfile;
    return origLoadPipelineContext(rId, role, stepKey, stepInput, modelProfile);
  };
  const runStep = makeRunStep(deps);

  await runStep(runId, 'architect', 'architect', { phase: 'plan' }, 'script');

  assert.equal(capturedModelProfile, 'deep', `architect step must pass modelProfile='deep'`);
  assert.equal(harness.appendEventArgs.length, 1, 'one event written');
});

test('runner failure → step_failed event + a fail-closed BLOCKER attempt (never a stranded DBOS error)', async () => {
  const runId = 'run-fail';
  const seededRoles = new Map<string, Role>([['architect', makeRole('architect', 'claude-code')]]);
  const { deps, harness, throwingClaudeCode } = buildRunStepDeps({ roles: seededRoles });
  // A claude-code role + the throwing runner: the runner-process failure becomes a DOMAIN blocking
  // result (needsHuman + BLOCKER attempt), NOT a thrown DBOS step error that strands task_runs=ready.
  deps.runAgent = throwingClaudeCode;
  const runStep = makeRunStep(deps);

  const result = await runStep(runId, 'architect', 'architect', { phase: 'plan' }, 'live');

  assert.equal(result.needsHuman, true, 'a runner crash parks the step (needsHuman)');
  assert.match(result.lesson ?? '', /RUNNER_NOT_IMPLEMENTED/);
  assert.equal((result.output as { verdict?: string }).verdict, 'BLOCKER', 'fail-closed verdict');
  assert.equal(harness.appendEventArgs.at(-1)?.type, 'step_failed');
  assert.equal(harness.appendAttemptInputs.at(-1)?.status, 'failed');
  assert.equal(harness.appendAttemptInputs.at(-1)?.verdict, 'BLOCKER');
});

test('attempt row surfaces the verdict + iteration (from stepKey) + a deterministic attemptId', async () => {
  const runId = 'run-attempt';
  const { deps, harness } = buildRunStepDeps();
  deps.runAgent = async (): Promise<AttemptResult> => ({
    output: { verdict: 'PASS' },
    nextSteps: [],
    costs: [{ modelProfile: 'standard', currency: 'USD', inputTokens: 10, outputTokens: 5, costAmount: 0.001 }],
    needsHuman: false,
  });
  const runStep = makeRunStep(deps);

  // A rework stepKey (`developer#2`) → iteration 2, attemptNo 3.
  await runStep(runId, 'developer', 'developer#2', { phase: 'rework' }, 'script');

  const attempt = harness.appendAttemptInputs[0];
  assert.ok(attempt, 'an attempt row is written');
  assert.equal(attempt.iteration, 2, 'iteration is parsed from the stepKey #k suffix');
  assert.equal(attempt.attemptNo, 3, 'attemptNo is iteration+1');
  assert.equal(attempt.verdict, 'PASS', 'the verdict is surfaced on the row');
  assert.equal(attempt.status, 'succeeded');
  assert.ok(attempt.attemptId.startsWith('attempt_'));
  assert.ok((attempt.inputTokens ?? 0) === 10 && (attempt.outputTokens ?? 0) === 5, 'tokens aggregated from costs');
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

  await runStep(runId, 'architect', 'architect', { phase: 'plan' }, 'script');

  const attempt = harness.appendAttemptInputs[0];
  assert.equal(attempt?.artifactRef, `${runId}/attempt_test`);
  assert.equal(attempt?.stdoutTail, 'stdout tail');
  assert.equal(attempt?.stderrTail, 'stderr tail');
});

test('per-role runner threading: a resolved stub runner dispatches via the stub (never the throwing claude-code)', async () => {
  const runId = 'run-thread';
  // Role is seeded with claude-code, but the resolved runner is the stub → dispatch must hit the stub.
  const seededRoles = new Map<string, Role>([['developer', makeRole('developer', 'claude-code')]]);
  const { deps, harness } = buildRunStepDeps({ roles: seededRoles });
  const profile: ExecutionProfile = { id: 'test', runnerOverrides: {} };
  const runStep = makeRunStep(deps);

  // resolvedRunnerId='stub-agent' → dispatchRunnerId → 'script' → stubRunAgent (no throw).
  const result = await runStep(runId, 'developer', 'developer', { phase: 'implement' }, 'stub-agent', profile);

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
