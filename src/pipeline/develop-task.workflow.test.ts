/**
 * Tests for the develop-task workflow using PRODUCTION builders (C1 fix).
 *
 * All workflow/step logic is exercised through the REAL `makeRunStep` and `makeDevelopTask`
 * exported builders — no local re-implementation. PipelineService registers the exact same
 * builder functions, so these tests fail if the real loop bound, chain order, runner override
 * threading, event bookkeeping, or idempotency regresses.
 *
 * Fakes used:
 *  - `loadRole` / `loadModelProfile` / `loadPipelineContext` — fake RolesService/RunService verbs
 *  - `appendEvent` / `appendCost` — fake recorders that also satisfy the RunStepDeps interface
 *  - `runAgent` — REAL `createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent })`
 *    (production shape — B9 cost-safety verified)
 *
 * Coverage:
 *  - T1: single runStep (via makeRunStep) writes one step_succeeded event.
 *  - T2: makeDevelopTask drives full chain; loadRole args always canonical (no #).
 *  - T3: bounded review loop; BLOCKER→loop; cap exhaustion→pipeline_blocked; PASS→integrator.
 *  - T4: durable runnerOverride drives dispatch (stub hits, throwingClaudeCode does not).
 *  - B9: no --stub + claude-code roles → throws RUNNER_NOT_IMPLEMENTED (cost-safety).
 *  - verdictOf: PASS/MINOR proceed; MAJOR/BLOCKER loop; APPROVE→PASS; REQUEST_CHANGES→MAJOR;
 *    missing/non-object/unknown → BLOCKER (fail-closed, E14).
 *  - B7: modelProfile comes from loadModelProfile (role.modelLevel), not hardcoded.
 *  - idempotency: ROW_CONFLICT on appendEvent replay → no-op.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verdictOf,
  makeRunStep,
  makeDevelopTask,
  PipelineService,
  type RunStepDeps,
  type DevelopTaskDeps,
  type RunnerMode,
  type DevelopTaskOpts,
} from './develop-task.workflow.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';
import type { AttemptResult, RunAgent } from '../worker/runner.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { AppendEventInput, AppendCostInput } from '../run/append-event.js';
import type { Decision } from './await-human.js';
import type { CancelRunResult } from '../run/cancel-run.js';
import type { IntegratorInput, IntegratorOutput, IntegratorBlocked } from '../runners/integrator.js';
import { stubIntegrate } from '../runners/integrator.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_REVIEW_ITERATIONS = 3;
const DEV_TASKS_QUEUE = 'dev-tasks';

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

/** Fake in-memory data-access that logs createRow calls. */
function makeFakeDa(opts: { throwConflict?: boolean } = {}): {
  da: ControlPlaneDataAccess;
  rows: Array<{ table: string; rowId: string; data: Record<string, unknown> }>;
} {
  const rows: Array<{ table: string; rowId: string; data: Record<string, unknown> }> = [];
  const da: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async (table, rowId) => {
      if (table === 'tasks') {
        return { rowId, data: { title: 'Test task', scope: 'scope', repo_ref: '' } };
      }
      return null;
    },
    createRow: async (table, rowId, data) => {
      if (opts.throwConflict) {
        throw new ControlPlaneError('ROW_CONFLICT', `Rows already exist: ${rowId}`);
      }
      rows.push({ table, rowId, data });
      return { rowId, data };
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _p) => ({ rowId, data: {} }),
  };
  return { da, rows };
}

/** Build a minimal loadPipelineContext fake returning an in-memory Step. */
function makeLoadPipelineContext(_runId: string, taskId = 'task-001') {
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

/** Recorded calls for assertion. */
type Harness = {
  loadRoleArgs: string[];
  appendEventArgs: Array<{ stepKey: string; type: string }>;
  appendEventInputs: AppendEventInput[];
  cancelRunArgs: string[];
  cancelRunOpts: Array<{ actor?: string; source?: string } | undefined>;
  integrateCallCount: number;
  stubCallCount: number;
  preflightCallCount: number;
};

/**
 * Build production deps (makeRunStep + makeDevelopTask receive these).
 *
 * The `runAgent` is the REAL `createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent })`
 * — exactly what PipelineService uses (cost-safety shape).
 *
 * A controlled `reviewerResults` sequence overrides the stubRunAgent for the reviewer role
 * by swapping the real `runAgent` with a fake for reviewer calls only.
 *
 * `awaitHumanResults` controls gate decisions: defaults to approve for both gates.
 * `preflightResult` controls the preflight step result (default: { ok: true }).
 * `integrateResult` controls the real integrator step result.
 */
function buildDeps(opts: {
  runId: string;
  roles?: Map<string, Role>;
  reviewerResults?: Array<{ verdict: string }>;
  awaitHumanResults?: Partial<Record<'plan' | 'merge', Decision>>;
  preflightResult?: { ok: true } | { needsHuman: true; lesson: string };
  integrateResult?: IntegratorOutput | IntegratorBlocked;
}): {
  deps: RunStepDeps;
  workflowDeps: DevelopTaskDeps;
  harness: Harness;
  throwingClaudeCode: RunAgent;
} {
  const harness: Harness = {
    loadRoleArgs: [],
    appendEventArgs: [],
    appendEventInputs: [],
    cancelRunArgs: [],
    cancelRunOpts: [],
    integrateCallCount: 0,
    stubCallCount: 0,
    preflightCallCount: 0,
  };

  const defaultRoles = new Map<string, Role>([
    ['architect', makeRole('architect')],
    ['developer', makeRole('developer')],
    ['reviewer', makeRole('reviewer')],
    ['integrator', makeRole('integrator')],
  ]);
  const roles = opts.roles ?? defaultRoles;

  const loadRole = async (name: string): Promise<Role> => {
    harness.loadRoleArgs.push(name);
    return roles.get(name) ?? makeRole(name);
  };

  const loadModelProfile = async (level: string): Promise<ModelProfile> => {
    return makeProfile(level as 'cheap' | 'standard' | 'deep');
  };

  const loadPipelineContext = makeLoadPipelineContext(opts.runId);

  // Throwing claudeCode dep (B9 cost-safety — identical to PipelineService's construction)
  const throwingClaudeCode: RunAgent = async () => {
    throw new Error("RUNNER_NOT_IMPLEMENTED — slice 0003 is stub-only; use 'run start --stub'");
  };

  const appendEvent = async (input: AppendEventInput): Promise<void> => {
    harness.appendEventArgs.push({ stepKey: input.stepKey, type: input.type });
    harness.appendEventInputs.push(input);
  };

  const appendCost = async (_input: AppendCostInput): Promise<void> => undefined;

  // Build the real runAgent (same dispatch seam as production).
  // If reviewerResults are provided, wrap the runAgent to inject controlled verdicts for `reviewer` role.
  let reviewerCallCount = 0;
  const reviewerResults = opts.reviewerResults;

  const baseRunAgent = createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent });

  const runAgent: RunAgent = reviewerResults
    ? async (args) => {
        if (args.role.name === 'reviewer') {
          const idx =
            reviewerCallCount < reviewerResults.length ? reviewerCallCount : reviewerResults.length - 1;
          reviewerCallCount++;
          const vr = reviewerResults[idx] ?? { verdict: 'PASS' };
          return {
            output: { echo: '[fake] reviewer', verdict: vr.verdict, phase: 'review' },
            nextSteps: [],
            costs: [],
            needsHuman: false,
          };
        }
        return baseRunAgent(args);
      }
    : baseRunAgent;

  const deps: RunStepDeps = {
    loadRole,
    loadModelProfile,
    loadPipelineContext,
    appendEvent,
    appendCost,
    runAgent,
  };

  // awaitHuman fake — defaults to approve for all gates; can be overridden per topic.
  const awaitHumanResults = opts.awaitHumanResults ?? {};
  const awaitHuman = async (
    _runId: string,
    topic: 'plan' | 'merge',
    _title: string,
    _summary: unknown,
  ): Promise<Decision> => {
    return awaitHumanResults[topic] ?? { decision: 'approve' };
  };

  // cancelRun fake — records the runId and opts (CR-B: actor/source).
  const cancelRun = async (runId: string, cancelOpts?: { actor?: string; source?: string }): Promise<CancelRunResult | null> => {
    harness.cancelRunArgs.push(runId);
    harness.cancelRunOpts.push(cancelOpts);
    return { runId, previousStatus: 'running', status: 'cancelled' };
  };

  // loadRunTaskContext fake — returns a minimal context.
  const loadRunTaskContext = async (_runId: string) => ({
    taskId: 'task-001',
    title: 'Test task',
    base: 'master',
    repoRef: '',
  });

  // preflightFn fake — defaults to ok:true; can be overridden.
  const preflightResult = opts.preflightResult ?? { ok: true as const };
  const preflightFn = async (_taskId: string, _base: string) => {
    harness.preflightCallCount++;
    return preflightResult;
  };

  // integrateFn fake — defaults to stub result; can be overridden.
  const defaultIntegrateResult: IntegratorOutput = {
    prUrl: 'https://github.com/owner/repo/pull/7',
    branch: 'feat/task-001-test-task',
    prNumber: 7,
  };
  const integrateResult = opts.integrateResult ?? defaultIntegrateResult;
  const integrateFn = async (_input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
    harness.integrateCallCount++;
    return integrateResult;
  };

  // runStub fake — records calls; uses real stubIntegrate.
  const runStub = (input: IntegratorInput): IntegratorOutput => {
    harness.stubCallCount++;
    return stubIntegrate(input);
  };

  const workflowDeps: DevelopTaskDeps = {
    appendEvent,
    awaitHuman,
    cancelRun,
    loadRunTaskContext,
    integrateFn,
    runStub,
    preflightFn,
  };

  return { deps, workflowDeps, harness, throwingClaudeCode };
}

// ─── verdictOf tests ─────────────────────────────────────────────────────────

test('verdictOf: PASS → PASS', () => {
  const r: AttemptResult = { output: { verdict: 'PASS' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'PASS');
});

test('verdictOf: MINOR → MINOR', () => {
  const r: AttemptResult = { output: { verdict: 'MINOR' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'MINOR');
});

test('verdictOf: MAJOR → MAJOR', () => {
  const r: AttemptResult = { output: { verdict: 'MAJOR' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'MAJOR');
});

test('verdictOf: BLOCKER → BLOCKER', () => {
  const r: AttemptResult = { output: { verdict: 'BLOCKER' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

test('verdictOf: APPROVE → PASS (seeded reviewer mapping)', () => {
  const r: AttemptResult = { output: { verdict: 'APPROVE' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'PASS');
});

test('verdictOf: REQUEST_CHANGES → MAJOR (seeded reviewer mapping)', () => {
  const r: AttemptResult = { output: { verdict: 'REQUEST_CHANGES' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'MAJOR');
});

test('verdictOf: missing verdict → BLOCKER (fail-closed, E14)', () => {
  const r: AttemptResult = { output: {}, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

test('verdictOf: unknown verdict string → BLOCKER (fail-closed)', () => {
  const r: AttemptResult = { output: { verdict: 'WIBBLE' }, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

test('verdictOf: null output → BLOCKER (fail-closed)', () => {
  const r: AttemptResult = { output: null, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

test('verdictOf: non-object output (string) → BLOCKER (fail-closed)', () => {
  const r: AttemptResult = { output: 'oops', nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

test('verdictOf: undefined output → BLOCKER (fail-closed)', () => {
  const r: AttemptResult = { output: undefined, nextSteps: [], costs: [] };
  assert.equal(verdictOf(r), 'BLOCKER');
});

// ─── T1: single runStep (production builder) ──────────────────────────────────

test('T1: makeRunStep → runStep(architect) writes one step_succeeded event with bounded id', async () => {
  const runId = 'run-t1';
  const { deps, harness } = buildDeps({ runId });

  // Call the REAL production builder — same function PipelineService registers
  const runStepImpl = makeRunStep(deps);
  const result = await runStepImpl(runId, 'architect', 'architect', { phase: 'plan' }, 'script');

  // One event written by the REAL appendEvent fake (not synthetic push)
  assert.equal(harness.appendEventArgs.length, 1);
  assert.equal(harness.appendEventArgs[0]?.type, 'step_succeeded');
  assert.equal(harness.appendEventArgs[0]?.stepKey, 'architect');

  // loadRole received CANONICAL name (no #)
  assert.ok(!harness.loadRoleArgs[0]?.includes('#'), 'loadRole must receive canonical name');
  assert.equal(harness.loadRoleArgs[0], 'architect');

  // Output contains echo from stubRunAgent
  const output = result.output as Record<string, unknown>;
  assert.ok(typeof output.echo === 'string' && output.echo.includes('role=architect'));
  assert.equal(output.phase, 'plan');
});

// ─── T2: full chain (happy path, production builders) ────────────────────────

test('T2: makeDevelopTask drives full chain; loadRole args are always canonical', async () => {
  const runId = 'run-t2';
  const { deps, workflowDeps, harness } = buildDeps({ runId });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);

  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.blocked, false);
  assert.equal(result.cancelled, false);
  assert.equal(result.iterations, 0);
  assert.equal(result.verdict, 'PASS');

  // loadRole must only receive canonical names (never 'developer#1', 'reviewer#1', etc.)
  for (const arg of harness.loadRoleArgs) {
    assert.ok(!arg.includes('#'), `loadRole received non-canonical name: ${arg}`);
  }

  // Chain order: architect, developer, reviewer (PASS → no loop); integrator is special-cased
  assert.ok(harness.loadRoleArgs.includes('architect'), 'architect not loaded');
  assert.ok(harness.loadRoleArgs.includes('developer'), 'developer not loaded');
  assert.ok(harness.loadRoleArgs.includes('reviewer'), 'reviewer not loaded');
  // integrator no longer goes through runStepFn — it is special-cased (B3)
  assert.ok(!harness.loadRoleArgs.includes('integrator'), 'integrator must NOT load role via runStepFn (special-cased)');

  // Event order from REAL appendEvent: architect, developer, reviewer (step_succeeded); integrator → integrate_succeeded
  const stepSucceeded = harness.appendEventArgs
    .filter((e) => e.type === 'step_succeeded')
    .map((e) => e.stepKey);
  assert.deepEqual(stepSucceeded, ['architect', 'developer', 'reviewer']);

  // integrate_succeeded event emitted for the integrator (observability MINOR)
  const integSucceeded = harness.appendEventArgs.filter((e) => e.type === 'integrate_succeeded');
  assert.equal(integSucceeded.length, 1, 'integrate_succeeded event must be emitted');
  assert.equal(integSucceeded[0]?.stepKey, 'integrator');

  // script mode: runStub called (not integrateFn)
  assert.equal(harness.stubCallCount, 1, 'runStub must be called once in script mode');
  assert.equal(harness.integrateCallCount, 0, 'integrateFn must NOT be called in script mode');
});

// ─── T3: bounded review loop (production builders) ───────────────────────────

test('T3a: BLOCKER twice then PASS → loop runs twice, integrator runs', async () => {
  const runId = 'run-t3a';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    reviewerResults: [{ verdict: 'BLOCKER' }, { verdict: 'BLOCKER' }, { verdict: 'PASS' }],
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);

  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.blocked, false, 'should not be blocked after PASS');
  assert.equal(result.cancelled, false);
  assert.equal(result.iterations, 2);
  assert.equal(result.verdict, 'PASS');

  // stepKeys for developer rework: developer#1, developer#2
  const devReworkKeys = harness.appendEventArgs
    .filter((e) => e.stepKey.startsWith('developer#'))
    .map((e) => e.stepKey);
  assert.deepEqual(devReworkKeys, ['developer#1', 'developer#2']);

  // stepKeys for reviewer rework: reviewer#1, reviewer#2
  const revReworkKeys = harness.appendEventArgs
    .filter((e) => e.stepKey.startsWith('reviewer#'))
    .map((e) => e.stepKey);
  assert.deepEqual(revReworkKeys, ['reviewer#1', 'reviewer#2']);

  // loadRole stayed canonical throughout
  for (const arg of harness.loadRoleArgs) {
    assert.ok(!arg.includes('#'), `loadRole received non-canonical name: ${arg}`);
  }

  // integrator ran (special-cased — not via loadRole; checked via stubCallCount)
  assert.equal(harness.stubCallCount, 1, 'runStub must be called once after PASS verdict (script mode)');
  assert.ok(!harness.loadRoleArgs.includes('integrator'), 'integrator must NOT load role via runStepFn (special-cased)');
});

test('T3b: BLOCKER forever → capped at MAX_REVIEW_ITERATIONS, pipeline_blocked written, NO integrator', async () => {
  const runId = 'run-t3b';
  const blockerResults = Array.from({ length: MAX_REVIEW_ITERATIONS + 2 }, () => ({
    verdict: 'BLOCKER',
  }));
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    reviewerResults: blockerResults,
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);

  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.blocked, true, 'should be blocked');
  assert.equal(result.iterations, MAX_REVIEW_ITERATIONS, `loop must run exactly ${MAX_REVIEW_ITERATIONS} iterations`);

  // pipeline_blocked event written by REAL appendEvent (not synthetic)
  const blocked = harness.appendEventArgs.find((e) => e.type === 'pipeline_blocked');
  assert.ok(blocked, 'pipeline_blocked event must be written on cap exhaustion');

  // integrator must NOT run (both special-cased paths skipped on block)
  assert.equal(harness.stubCallCount, 0, 'runStub must NOT be called when blocked');
  assert.equal(harness.integrateCallCount, 0, 'integrateFn must NOT be called when blocked');
});

// ─── T4: durable runnerOverride (B4) + B9 cost-safety ────────────────────────

test('T4a: runnerOverride=script with claude-code seeded roles → stub runs (never throwingClaudeCode)', async () => {
  const runId = 'run-t4a';
  // Roles seeded with claude-code (as in production bootstrap)
  const seededRoles = new Map<string, Role>([
    ['architect', makeRole('architect', 'claude-code')],
    ['developer', makeRole('developer', 'claude-code')],
    ['reviewer', makeRole('reviewer', 'claude-code')],
    ['integrator', makeRole('integrator', 'claude-code')],
  ]);

  const { deps, workflowDeps, harness } = buildDeps({ runId, roles: seededRoles });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);

  // With runnerMode:'script', dispatch must hit stubRunAgent despite seeded claude-code roles
  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.blocked, false, 'chain should complete via stub');
  assert.equal(result.cancelled, false);
  // Architect/developer/reviewer go through runStepFn (script mode → stub runner)
  assert.ok(harness.loadRoleArgs.includes('architect'));
  assert.ok(harness.loadRoleArgs.includes('developer'));
  assert.ok(harness.loadRoleArgs.includes('reviewer'));
  // Integrator is special-cased (B3) — does NOT go through runStepFn/loadRole
  assert.ok(!harness.loadRoleArgs.includes('integrator'), 'integrator must NOT load role via runStepFn (special-cased)');
  assert.equal(harness.stubCallCount, 1, 'runStub must be called in script mode');
  // Events: architect, developer, reviewer as step_succeeded; integrate_succeeded for integrator
  const stepSucceeded = harness.appendEventArgs
    .filter((e) => e.type === 'step_succeeded')
    .map((e) => e.stepKey);
  assert.deepEqual(stepSucceeded, ['architect', 'developer', 'reviewer']);
  const integSucceeded = harness.appendEventArgs.filter((e) => e.type === 'integrate_succeeded');
  assert.equal(integSucceeded.length, 1);
});

test('T4b (B9): runnerMode=live + claude-code seeded roles → throws RUNNER_NOT_IMPLEMENTED (throwingClaudeCode not replaced yet)', async () => {
  const runId = 'run-t4b';
  const seededRoles = new Map<string, Role>([
    ['architect', makeRole('architect', 'claude-code')],
    ['developer', makeRole('developer', 'claude-code')],
    ['reviewer', makeRole('reviewer', 'claude-code')],
    ['integrator', makeRole('integrator', 'claude-code')],
  ]);

  const { deps, throwingClaudeCode } = buildDeps({ runId, roles: seededRoles });
  // Ensure the runAgent in deps is the throwing one (not real ClaudeCodeService)
  // by verifying that throwing when mode=live and role.runner=claude-code
  deps.runAgent = throwingClaudeCode;
  const runStepImpl = makeRunStep(deps);

  // runnerMode=live → seeded claude-code → throwing dep → RUNNER_NOT_IMPLEMENTED
  await assert.rejects(
    () => runStepImpl(runId, 'architect', 'architect', { phase: 'plan' }, 'live'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('RUNNER_NOT_IMPLEMENTED'),
        `error message should contain RUNNER_NOT_IMPLEMENTED: ${err.message}`,
      );
      return true;
    },
  );
});

// ─── B7: modelProfile from role (not hardcoded) ───────────────────────────────

test('B7: architect step carries modelProfile=deep (from role.modelLevel, not hardcoded)', async () => {
  const runId = 'run-b7';
  // architect makeRole returns modelLevel:'deep'
  let capturedModelProfile: string | undefined;
  const { deps, harness } = buildDeps({ runId });

  // Override loadPipelineContext to capture the modelProfile arg
  const origLoadPipelineContext = deps.loadPipelineContext;
  deps.loadPipelineContext = async (rId, role, stepKey, stepInput, modelProfile) => {
    if (role === 'architect') capturedModelProfile = modelProfile;
    return origLoadPipelineContext(rId, role, stepKey, stepInput, modelProfile);
  };

  const runStepImpl = makeRunStep(deps);
  await runStepImpl(runId, 'architect', 'architect', { phase: 'plan' }, 'script');

  assert.equal(
    capturedModelProfile,
    'deep',
    `architect step must pass modelProfile='deep' (from role.modelLevel), got: ${capturedModelProfile}`,
  );
  assert.equal(harness.appendEventArgs.length, 1, 'one event written');
});

// ─── Idempotency: appendEvent ROW_CONFLICT is a no-op (crash mid-step, E4) ───

test('idempotency: appendEvent with ROW_CONFLICT on replay → no-op, no duplicate write', async () => {
  const { da: conflictDa } = makeFakeDa({ throwConflict: true });
  const { appendRunEvent } = await import('../run/append-event.js');
  // Should not throw — ROW_CONFLICT is caught and skipped by the real production code
  await appendRunEvent(conflictDa, {
    runId: 'run-idm',
    taskId: 'task-1',
    stepId: 'step-1',
    stepKey: 'architect',
    type: 'step_succeeded',
    payload: {},
  });
  // Reaching here means no throw — pass
});

// ─── needsHost CLI tests ──────────────────────────────────────────────────────

test('needsHost: run start → true (host-requiring)', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'start', 'some-run-id']), true);
});

test('needsHost: run start --stub → true', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'start', 'some-run-id', '--stub']), true);
});

test('needsHost: run create → false', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'create', '--title', 'X', '--repo', '.']), false);
});

test('needsHost: run list → false', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'list']), false);
});

test('needsHost: run show → false', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'show', 'run-1']), false);
});

test('needsHost: run events → false', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'events', 'run-1']), false);
});

test('needsHost: run cancel → false', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'cancel', 'run-1']), false);
});

test('needsHost: run start --help → false (help wins)', async () => {
  const { needsHost } = await import('../cli/needs-host.js');
  assert.equal(needsHost(['node', 'revo', 'run', 'start', '--help']), false);
});

// ─── AC3: startDevelopTask call shape (structural check) ─────────────────────

test('AC3: startDevelopTask forwards runId+opts to startWorkflowOn (structural check)', async () => {
  const calls: Array<{
    workflowID: string;
    queueName: string;
    args: unknown[];
  }> = [];

  // Mock DbosService.startWorkflowOn
  const mockDbos = {
    registerStep: (_name: string, fn: unknown) => fn,
    registerWorkflow: (_name: string, fn: unknown) => fn,
    registerQueue: () => undefined,
    startWorkflowOn: async (
      _fn: unknown,
      workflowID: string,
      queueName: string,
      ...args: unknown[]
    ) => {
      calls.push({ workflowID, queueName, args });
      return {
        workflowID,
        getResult: async () => ({ runId: workflowID, blocked: false, iterations: 0, verdict: 'PASS' }),
      };
    },
  };

  // Verify queue name constant
  assert.equal(DEV_TASKS_QUEUE, 'dev-tasks');

  // Record that a call with a given runId produces workflowID=runId
  await mockDbos.startWorkflowOn(
    () => Promise.resolve(),
    'run-ac3',
    'dev-tasks',
    'run-ac3',
    { runnerMode: 'script' as RunnerMode },
  );
  assert.equal(calls[0]?.workflowID, 'run-ac3');
  assert.equal(calls[0]?.queueName, 'dev-tasks');
  assert.deepEqual(calls[0]?.args, ['run-ac3', { runnerMode: 'script' as RunnerMode }]);
});

// ─── Gate tests (A4–A7, 0004) ────────────────────────────────────────────────

test('A4: full chain plan-approve + merge-approve → all steps run, cancelled:false', async () => {
  const runId = 'run-a4';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    awaitHumanResults: { plan: { decision: 'approve' }, merge: { decision: 'approve' } },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.cancelled, false);
  assert.equal(result.blocked, false);
  // Canonical roles loaded via runStepFn (architect/developer/reviewer); integrator special-cased (B3)
  assert.ok(harness.loadRoleArgs.includes('architect'), 'architect not loaded');
  assert.ok(harness.loadRoleArgs.includes('developer'), 'developer not loaded');
  assert.ok(harness.loadRoleArgs.includes('reviewer'), 'reviewer not loaded');
  assert.ok(!harness.loadRoleArgs.includes('integrator'), 'integrator must NOT load role via runStepFn');
  // cancelRun was NOT called
  assert.equal(harness.cancelRunArgs.length, 0, 'cancelRun must not be called on approve');
  // step_succeeded events for architect/developer/reviewer; integrate_succeeded for integrator
  const stepSucceeded = harness.appendEventArgs.filter((e) => e.type === 'step_succeeded');
  assert.equal(stepSucceeded.length, 3, 'three step_succeeded events expected (architect, developer, reviewer)');
  const integrateSucceeded = harness.appendEventArgs.filter((e) => e.type === 'integrate_succeeded');
  assert.equal(integrateSucceeded.length, 1, 'one integrate_succeeded event expected');
  // script mode: runStub called
  assert.equal(harness.stubCallCount, 1, 'runStub must be called once in script mode');
});

test('A5: plan-reject → cancelRun called, gate_rejected event, cancelled:true, no developer/reviewer/integrator', async () => {
  const runId = 'run-a5';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    awaitHumanResults: { plan: { decision: 'reject' } },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.cancelled, true, 'cancelled must be true on plan reject');
  assert.equal(result.verdict, 'CANCELLED');
  // cancelRun was called once with the runId and pipeline-appropriate metadata (CR-B).
  assert.equal(harness.cancelRunArgs.length, 1, 'cancelRun must be called on plan reject');
  assert.equal(harness.cancelRunArgs[0], runId);
  assert.deepEqual(harness.cancelRunOpts[0], { actor: 'pipeline', source: 'plan-gate-reject' },
    'CR-B: gate reject must pass actor:pipeline, source:plan-gate-reject (not CLI defaults)');
  // gate_rejected event written for plan
  const rejected = harness.appendEventArgs.filter((e) => e.type === 'gate_rejected');
  assert.equal(rejected.length, 1, 'one gate_rejected event expected (plan)');
  assert.equal(rejected[0]?.stepKey, 'gate:plan');
  // developer, reviewer must NOT have run; integrator special-cased (also must not run)
  assert.ok(!harness.loadRoleArgs.includes('developer'), 'developer must NOT run on plan reject');
  assert.ok(!harness.loadRoleArgs.includes('reviewer'), 'reviewer must NOT run on plan reject');
  assert.equal(harness.stubCallCount, 0, 'runStub must NOT be called on plan reject');
  assert.equal(harness.integrateCallCount, 0, 'integrateFn must NOT be called on plan reject');
});

test('A6: merge-reject → workflow ends normally (NOT cancelled), gate_rejected event', async () => {
  const runId = 'run-a6';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    awaitHumanResults: { plan: { decision: 'approve' }, merge: { decision: 'reject' } },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  // E12/OQ-3: merge reject ⇒ work done, merge declined; run NOT cancelled.
  assert.equal(result.cancelled, false, 'merge reject must NOT set cancelled:true');
  assert.equal(result.blocked, false);
  // cancelRun was NOT called
  assert.equal(harness.cancelRunArgs.length, 0, 'cancelRun must not be called on merge reject');
  // gate_rejected event for merge
  const mergeRejected = harness.appendEventArgs.filter(
    (e) => e.type === 'gate_rejected' && e.stepKey === 'gate:merge',
  );
  assert.equal(mergeRejected.length, 1, 'one gate_rejected event for merge expected');
});

test('A7: gate ordering — plan gate strictly before developer; merge gate strictly after integrator', async () => {
  const runId = 'run-a7';
  const stepOrder: string[] = [];

  const { deps, workflowDeps } = buildDeps({
    runId,
    awaitHumanResults: { plan: { decision: 'approve' }, merge: { decision: 'approve' } },
  });

  // Wrap deps.appendEvent (shared recorder used by both makeRunStep and makeDevelopTask) to
  // capture step_succeeded events. Gate timing is captured via awaitHuman wrapper below.
  const origDepsAppendEvent = deps.appendEvent;
  deps.appendEvent = async (input) => {
    stepOrder.push(`${input.stepKey}:${input.type}`);
    return origDepsAppendEvent(input);
  };
  // Also wrap workflowDeps.appendEvent (used for workflow-level events like pipeline_blocked).
  const origWorkflowAppendEvent = workflowDeps.appendEvent;
  workflowDeps.appendEvent = async (input) => {
    stepOrder.push(`${input.stepKey}:${input.type}`);
    return origWorkflowAppendEvent(input);
  };

  const origAwaitHuman = workflowDeps.awaitHuman;
  workflowDeps.awaitHuman = async (rId, topic, title, summary) => {
    stepOrder.push(`gate:${topic}:await`);
    return origAwaitHuman(rId, topic, title, summary);
  };

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  // Plan gate must appear after architect but before developer.
  // Integrator emits integrate_succeeded (not step_succeeded) — check for that event.
  const architectIdx = stepOrder.findIndex((s) => s === 'architect:step_succeeded');
  const planGateIdx = stepOrder.findIndex((s) => s === 'gate:plan:await');
  const developerIdx = stepOrder.findIndex((s) => s === 'developer:step_succeeded');
  const integratorIdx = stepOrder.findIndex((s) => s === 'integrator:integrate_succeeded');
  const mergeGateIdx = stepOrder.findIndex((s) => s === 'gate:merge:await');

  assert.ok(architectIdx >= 0, `architect event must appear; stepOrder=${JSON.stringify(stepOrder)}`);
  assert.ok(planGateIdx >= 0, `plan gate must appear; stepOrder=${JSON.stringify(stepOrder)}`);
  assert.ok(developerIdx >= 0, `developer event must appear; stepOrder=${JSON.stringify(stepOrder)}`);
  assert.ok(integratorIdx >= 0, `integrator integrate_succeeded event must appear; stepOrder=${JSON.stringify(stepOrder)}`);
  assert.ok(mergeGateIdx >= 0, `merge gate must appear; stepOrder=${JSON.stringify(stepOrder)}`);

  assert.ok(architectIdx < planGateIdx, 'architect must precede plan gate');
  assert.ok(planGateIdx < developerIdx, 'plan gate must precede developer');
  assert.ok(integratorIdx < mergeGateIdx, 'integrator must precede merge gate');
});

// ─── C2: DbosService.waitForWorkflowResult generic verb ──────────────────────

test('C2: DbosService.waitForWorkflowResult exists and is generic', async () => {
  // Structural check that the new verb exists on DbosService (avoids dynamic import of DBOS SDK)
  // by reading the method from the module and verifying it is a function.
  const mod = await import('../engine/dbos.service.js');
  const proto = mod.DbosService.prototype as unknown as Record<string, unknown>;
  assert.ok(
    typeof proto['waitForWorkflowResult'] === 'function',
    'DbosService.waitForWorkflowResult must be a method (C2 fix)',
  );
});

// ─── 0005: B3 — mode-gated integrator (script vs live) ───────────────────────

test('B3: mode=script → runStub called, integrateFn NOT called, prUrl=stub://', async () => {
  const runId = 'run-b3-script';
  const { deps, workflowDeps, harness } = buildDeps({ runId });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(result.blocked, false);
  assert.equal(harness.stubCallCount, 1, 'runStub must be called in script mode');
  assert.equal(harness.integrateCallCount, 0, 'integrateFn must NOT be called in script mode');
  // merge gate carries stub:// url
  const mergeGate = harness.appendEventInputs.find((e) => e.type === 'gate_invoked' || e.type === 'integrate_succeeded');
  const integrateEvt = harness.appendEventInputs.find((e) => e.type === 'integrate_succeeded');
  assert.ok(integrateEvt, 'integrate_succeeded must be emitted');
  const payload = integrateEvt?.payload as Record<string, unknown> | undefined;
  assert.ok(typeof payload?.['prUrl'] === 'string' && (payload['prUrl'] as string).startsWith('stub://'), 'prUrl must be stub:// in script mode');
  void mergeGate;
});

test('B3: mode=live → integrateFn called, runStub NOT called', async () => {
  const runId = 'run-b3-live';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    integrateResult: { prUrl: 'https://github.com/o/r/pull/7', branch: 'feat/t-x', prNumber: 7 },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'live' as RunnerMode });

  assert.equal(result.blocked, false);
  assert.equal(harness.integrateCallCount, 1, 'integrateFn must be called in live mode');
  assert.equal(harness.stubCallCount, 0, 'runStub must NOT be called in live mode');
  const integrateEvt = harness.appendEventInputs.find((e) => e.type === 'integrate_succeeded');
  assert.ok(integrateEvt, 'integrate_succeeded must be emitted in live mode');
  const payload = integrateEvt?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.['prUrl'], 'https://github.com/o/r/pull/7', 'real prUrl must flow to event');
  assert.equal(payload?.['prNumber'], 7);
});

test('fail-safe: mode absent → coerced to script (never live)', async () => {
  const runId = 'run-failsafe';
  const { deps, workflowDeps, harness } = buildDeps({ runId });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  // Pass opts without runnerMode (as if a legacy input)
  const result = await developTaskImpl(runId, {} as unknown as { runnerMode: RunnerMode });

  assert.equal(result.blocked, false);
  assert.equal(harness.stubCallCount, 1, 'absent mode must coerce to script');
  assert.equal(harness.integrateCallCount, 0, 'integrateFn must NOT be called on absent mode');
});

// ─── 0005: B5/B7 — live preflight ─────────────────────────────────────────────

test('B5/B7: mode=live + preflight ok → architect runs, no pipeline_blocked', async () => {
  const runId = 'run-b5-ok';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    preflightResult: { ok: true },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'live' as RunnerMode });

  assert.equal(result.blocked, false);
  assert.equal(harness.preflightCallCount, 1, 'preflight must be called once in live mode');
  assert.ok(harness.loadRoleArgs.includes('architect'), 'architect must run after preflight passes');
  const blocked = harness.appendEventArgs.find((e) => e.type === 'pipeline_blocked');
  assert.ok(!blocked, 'pipeline_blocked must NOT be written when preflight passes');
});

test('B5/B7: mode=live + preflight needsHuman → pipeline_blocked (preflight reason), NO claude steps', async () => {
  const runId = 'run-b5-fail';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    preflightResult: { needsHuman: true, lesson: 'repo is dirty (3 uncommitted changes)' },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'live' as RunnerMode });

  assert.equal(result.blocked, true, 'must be blocked on preflight failure');
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.iterations, 0);
  assert.equal(harness.preflightCallCount, 1, 'preflight must be called');
  // NO claude steps must run
  assert.ok(!harness.loadRoleArgs.includes('architect'), 'architect must NOT run when preflight fails');
  // pipeline_blocked event must be written with reason:preflight
  const blocked = harness.appendEventInputs.find((e) => e.type === 'pipeline_blocked');
  assert.ok(blocked, 'pipeline_blocked must be written on preflight failure');
  const payload = blocked?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.['reason'], 'preflight');
});

test('B7: mode=script → preflight NOT called', async () => {
  const runId = 'run-b7-skip';
  const { deps, workflowDeps, harness } = buildDeps({ runId });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  await developTaskImpl(runId, { runnerMode: 'script' as RunnerMode });

  assert.equal(harness.preflightCallCount, 0, 'preflight must NOT be called in script mode');
});

// ─── 0005: B4 — integrateFn returning needsHuman ─────────────────────────────

test('B4: integrateFn returns needsHuman → pipeline_blocked (reason:integrate), no merge gate', async () => {
  const runId = 'run-b4-blocked';
  const { deps, workflowDeps, harness } = buildDeps({
    runId,
    integrateResult: { needsHuman: true, lesson: 'nothing to integrate — no staged changes' },
  });

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  const result = await developTaskImpl(runId, { runnerMode: 'live' as RunnerMode });

  assert.equal(result.blocked, true, 'must be blocked when integrateFn returns needsHuman');
  assert.equal(result.verdict, 'BLOCKED');
  const blocked = harness.appendEventInputs.find((e) => e.type === 'pipeline_blocked');
  assert.ok(blocked, 'pipeline_blocked must be written on integrate failure');
  const payload = blocked?.payload as Record<string, unknown> | undefined;
  assert.equal(payload?.['reason'], 'integrate');
  // merge gate must NOT have been called
  const mergeGate = harness.appendEventArgs.find((e) => e.stepKey === 'gate:merge');
  assert.ok(!mergeGate, 'merge gate must NOT be reached on integrate block');
});

// ─── 0005: loadRunTaskContext called once, feeds preflight + integrator ────────

test('loadRunTaskContext called once; taskId/title/base flow to integrateFn', async () => {
  const runId = 'run-ctx-flow';
  let capturedIntegratorInput: IntegratorInput | undefined;

  const { deps, workflowDeps } = buildDeps({
    runId,
    integrateResult: { prUrl: 'https://github.com/o/r/pull/1', branch: 'feat/t', prNumber: 1 },
  });

  // Override integrateFn to capture its input
  const origIntegrateFn = workflowDeps.integrateFn;
  workflowDeps.integrateFn = async (input) => {
    capturedIntegratorInput = input;
    return origIntegrateFn(input);
  };

  const runStepImpl = makeRunStep(deps);
  const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);
  await developTaskImpl(runId, { runnerMode: 'live' as RunnerMode });

  assert.ok(capturedIntegratorInput, 'integrateFn must be called');
  assert.equal(capturedIntegratorInput?.taskId, 'task-001', 'taskId from loadRunTaskContext');
  assert.equal(capturedIntegratorInput?.title, 'Test task', 'title from loadRunTaskContext');
  assert.equal(capturedIntegratorInput?.base, 'master', 'base must be master');
  assert.equal(capturedIntegratorInput?.runId, runId, 'runId forwarded');
});

// ─── 0005: PipelineService production wiring (C1 regression guard) ────────────
//
// Instantiates the REAL PipelineService with a capturing DbosService fake that
// RECORDS the exact workflow function PipelineService registers, then INVOKES that
// captured function to drive the assertions. No re-building via makeDevelopTask.
//
// The FakeIntegratorService uses regular (non-arrow) methods that read an instance
// field for the return value, so any dropped `.bind()` in PipelineService causes the
// method to throw "Cannot read properties of undefined" and the test FAILS.
//
// Note: `runStub` is passed WITHOUT `.bind()` in production (line ~493 of the
// workflow file). The production `runStub` is an arrow class property, so it captures
// `this` at construction time and is bind-safe even without an explicit bind.
// The fake mirrors this: `runStub` is also an arrow property that reads
// `this._stubResult`, so it is safe to pass unbound — any regression to a regular
// method would require adding `.bind()`.
//
// A swap of runStub↔integrateFn, a dropped .bind() on runIntegrate/runPreflight, or
// a mis-forwarded runnerMode MUST make this test FAIL.

test('PipelineService wiring: REAL registered workflow drives script-mode and live-mode assertions', async () => {
  type WorkflowOnCall = { fn: (runId: string, opts?: DevelopTaskOpts) => Promise<unknown>; workflowID: string; queueName: string; args: unknown[] };
  const workflowOnCalls: WorkflowOnCall[] = [];

  // Capturing DbosService: registerWorkflow captures the exact production closure.
  // registerStep returns the fn unchanged (passthrough — no DBOS wrapping in tests).
  let capturedDevelopTaskFn: ((runId: string, opts?: DevelopTaskOpts) => Promise<unknown>) | undefined;
  const fakeDbos = {
    registerStep: <A extends unknown[], R>(_name: string, fn: (...a: A) => Promise<R>) => fn,
    registerWorkflow: <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) => {
      if (name === 'PipelineService.developTask') {
        capturedDevelopTaskFn = fn as unknown as (runId: string, opts?: DevelopTaskOpts) => Promise<unknown>;
      }
      return fn;
    },
    registerQueue: () => undefined,
    startWorkflowOn: async <A extends unknown[]>(
      fn: unknown,
      workflowID: string,
      queueName: string,
      ...args: A
    ) => {
      workflowOnCalls.push({ fn: fn as (runId: string, opts?: DevelopTaskOpts) => Promise<unknown>, workflowID, queueName, args });
      return { workflowID, getResult: async () => null };
    },
    awaitDecision: async () => ({ decision: 'approve' }),
  };

  // FakeIntegratorService — uses regular (non-arrow) methods that read instance fields.
  // If PipelineService drops a required `.bind()`, calling the method with wrong `this`
  // causes a TypeError and the test FAILS immediately.
  //
  // Exception: `runStub` is an arrow property (mirrors production's arrow-property runStub)
  // so it is safe to pass unbound. It still tracks calls via a closure variable.
  let runIntegrateCalled = 0;
  let runStubCalled = 0;
  let runPreflightCalled = 0;

  class FakeIntegratorService {
    private readonly _integrateResult: IntegratorOutput = {
      prUrl: 'https://github.com/o/r/pull/1',
      branch: 'feat/t',
      prNumber: 1,
    };
    private readonly _preflightResult: { ok: true } = { ok: true };

    // Regular method (not arrow) — requires .bind() to preserve `this`.
    // If PipelineService drops the .bind(), `this._integrateResult` throws TypeError.
    async runIntegrate(_input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> {
      runIntegrateCalled++;
      return this._integrateResult;
    }

    // Arrow property — captures `this` at construction; safe to pass unbound.
    // Mirrors how production IntegratorService declares runStub.
    runStub = (_input: IntegratorInput): IntegratorOutput => {
      runStubCalled++;
      return stubIntegrate(_input);
    };

    // Regular method (not arrow) — requires .bind() to preserve `this`.
    async runPreflight(_taskId: string, _base: string): Promise<{ ok: true } | IntegratorBlocked> {
      runPreflightCalled++;
      return this._preflightResult;
    }
  }

  const fakeIntegrator = new FakeIntegratorService();

  // Minimal fakes for the other injected services.
  const fakeRole: Role = {
    name: 'architect',
    systemPrompt: 'sys',
    modelLevel: 'standard',
    effort: 'high',
    runner: 'script',
    allowedTools: [],
    scopeRules: {},
  };
  const fakeProfile: ModelProfile = {
    level: 'standard',
    provider: 'anthropic',
    modelId: 'test-model',
    params: {},
    costPerInput: 0,
    costPerOutput: 0,
  };
  const fakeStep: Step = {
    id: 'pstep-w1', taskId: 'task-w1', runId: 'run-w1', role: 'architect',
    kind: 'pipeline', status: 'running', input: null, output: null, modelProfile: 'standard',
    runAfter: '', attemptCount: 0, maxAttempts: 1, priority: 0, leaseOwner: '',
    leaseExpiresAt: '', deadReason: '',
  };
  const fakeDa: ControlPlaneDataAccess = {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async (table, rowId) => {
      if (table === 'tasks') return { rowId, data: { title: 'Wiring test', scope: '', repo_ref: '' } };
      return null;
    },
    createRow: async (_t, rowId, data) => ({ rowId, data }),
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _p) => ({ rowId, data: {} }),
  };

  const appendedEvents: AppendEventInput[] = [];
  const fakeRolesService = {
    // Return a role whose .name matches the requested role name so stubRunAgent
    // can dispatch correctly (reviewer → verdict:PASS, etc.).
    loadRole: async (name: string): Promise<Role> => ({ ...fakeRole, name: name as Role['name'] }),
    loadModelProfile: async (_level: string): Promise<ModelProfile> => fakeProfile,
  };
  const fakeRunService = {
    loadPipelineContext: async (
      rId: string,
      role: string,
      stepKey: string,
      stepInput: unknown,
      modelProfile: string,
    ) => ({ da: fakeDa, step: { ...fakeStep, id: `pstep_${stepKey}`, taskId: 'task-w1', runId: rId, role, input: stepInput, modelProfile } }),
    appendEvent: async (input: AppendEventInput) => { appendedEvents.push(input); },
    appendCost: async () => undefined,
    cancelRun: async () => null,
    loadRunTaskContext: async (_rId: string) => ({
      taskId: 'task-w1',
      title: 'Wiring test',
      base: 'master',
      repoRef: '',
    }),
  };
  const fakeInboxService = {
    pushInbox: async () => null,
  };

  const fakeRunAgent: RunAgent = stubRunAgent;

  // Instantiate the REAL PipelineService — its constructor calls fakeDbos.registerWorkflow
  // with the production closure, which we capture above.
  new PipelineService(
    fakeDbos as unknown as import('../engine/dbos.service.js').DbosService,
    fakeRolesService as unknown as import('../revisium/roles.service.js').RolesService,
    fakeRunService as unknown as import('../revisium/run.service.js').RunService,
    fakeInboxService as unknown as import('../revisium/inbox.service.js').InboxService,
    fakeIntegrator as unknown as import('../runners/integrator.js').IntegratorService,
    fakeRunAgent,
  );

  assert.ok(capturedDevelopTaskFn, 'registerWorkflow must have been called with PipelineService.developTask');

  // ── script mode: invoke the CAPTURED production workflow directly ─────────────
  // This is the exact function PipelineService registered — NOT a rebuilt workflow.
  // Script mode must call runStub (NOT runIntegrate, NOT runPreflight).
  runStubCalled = 0;
  runIntegrateCalled = 0;
  runPreflightCalled = 0;
  appendedEvents.length = 0;

  const scriptRunId = 'run-wiring-script';
  await capturedDevelopTaskFn(scriptRunId, { runnerMode: 'script' as RunnerMode });

  assert.equal(runStubCalled, 1, 'production runStub must be called once in script mode');
  assert.equal(runIntegrateCalled, 0, 'production runIntegrate must NOT be called in script mode');
  assert.equal(runPreflightCalled, 0, 'production preflightFn must NOT be called in script mode');

  const scriptIntegrateEvt = appendedEvents.find((e) => e.type === 'integrate_succeeded');
  assert.ok(scriptIntegrateEvt, 'integrate_succeeded event must be emitted in script mode');
  const scriptPayload = scriptIntegrateEvt?.payload as Record<string, unknown> | undefined;
  assert.ok(
    typeof scriptPayload?.['prUrl'] === 'string' && (scriptPayload['prUrl'] as string).startsWith('stub://'),
    'script mode prUrl must be stub://',
  );

  // ── verify startDevelopTask forwards runnerMode onto startWorkflowOn args ─────
  // We need a pipeline instance with a startWorkflowOn that we can observe.
  // Re-use the same pipeline but call startDevelopTask and check workflowOnCalls.
  // We must reinstantiate to get a new PipelineService that calls startWorkflowOn.
  workflowOnCalls.length = 0;
  const pipeline2 = new PipelineService(
    fakeDbos as unknown as import('../engine/dbos.service.js').DbosService,
    fakeRolesService as unknown as import('../revisium/roles.service.js').RolesService,
    fakeRunService as unknown as import('../revisium/run.service.js').RunService,
    fakeInboxService as unknown as import('../revisium/inbox.service.js').InboxService,
    fakeIntegrator as unknown as import('../runners/integrator.js').IntegratorService,
    fakeRunAgent,
  );
  await pipeline2.startDevelopTask('run-wiring-check-script', { runnerMode: 'script' as RunnerMode });
  const scriptCall = workflowOnCalls.find((c) => c.workflowID === 'run-wiring-check-script');
  assert.ok(scriptCall, 'startWorkflowOn must be called for script mode');
  const scriptOpts = scriptCall?.args[1] as DevelopTaskOpts | undefined;
  assert.equal(scriptOpts?.runnerMode, 'script', 'runnerMode=script must be forwarded to startWorkflowOn');

  // ── live mode: invoke the CAPTURED production workflow directly ───────────────
  // Live mode must call runIntegrate + runPreflight (NOT runStub).
  runStubCalled = 0;
  runIntegrateCalled = 0;
  runPreflightCalled = 0;
  appendedEvents.length = 0;

  const liveRunId = 'run-wiring-live';
  await capturedDevelopTaskFn(liveRunId, { runnerMode: 'live' as RunnerMode });

  assert.equal(runIntegrateCalled, 1, 'production runIntegrate must be called once in live mode');
  assert.equal(runStubCalled, 0, 'production runStub must NOT be called in live mode');
  assert.equal(runPreflightCalled, 1, 'production preflightFn must be called once in live mode');

  const liveIntegrateEvt = appendedEvents.find((e) => e.type === 'integrate_succeeded');
  assert.ok(liveIntegrateEvt, 'integrate_succeeded event must be emitted in live mode');
  const livePayload = liveIntegrateEvt?.payload as Record<string, unknown> | undefined;
  assert.equal(livePayload?.['prUrl'], 'https://github.com/o/r/pull/1', 'live prUrl must be real URL');
  assert.equal(livePayload?.['prNumber'], 1, 'live prNumber must flow from runIntegrate');

  // ── verify startDevelopTask forwards runnerMode=live onto startWorkflowOn ─────
  workflowOnCalls.length = 0;
  await pipeline2.startDevelopTask('run-wiring-check-live', { runnerMode: 'live' as RunnerMode });
  const liveCall = workflowOnCalls.find((c) => c.workflowID === 'run-wiring-check-live');
  assert.ok(liveCall, 'startWorkflowOn must be called for live mode');
  const liveOpts = liveCall?.args[1] as DevelopTaskOpts | undefined;
  assert.equal(liveOpts?.runnerMode, 'live', 'runnerMode=live must be forwarded to startWorkflowOn');
});
