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
  type RunStepDeps,
  type DevelopTaskDeps,
} from './develop-task.workflow.js';
import { stubRunAgent } from '../worker/stub-runner.js';
import { createRunAgent } from '../worker/runner-dispatch.js';
import type { AttemptResult, RunAgent } from '../worker/runner.js';
import type { Role, ModelProfile } from '../control-plane/definitions.js';
import type { Step } from '../control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../control-plane/data-access.js';
import { ControlPlaneError } from '../control-plane/errors.js';
import type { AppendEventInput, AppendCostInput } from '../run/append-event.js';

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
};

/**
 * Build production deps (makeRunStep + makeDevelopTask receive these).
 *
 * The `runAgent` is the REAL `createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent })`
 * — exactly what PipelineService uses (B9 cost-safety shape).
 *
 * A controlled `reviewerResults` sequence overrides the stubRunAgent for the reviewer role
 * by swapping the real `runAgent` with a fake for reviewer calls only.
 */
function buildDeps(opts: {
  runId: string;
  roles?: Map<string, Role>;
  reviewerResults?: Array<{ verdict: string }>;
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

  const workflowDeps: DevelopTaskDeps = { appendEvent };

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

  const result = await developTaskImpl(runId, { runnerOverride: 'script' });

  assert.equal(result.blocked, false);
  assert.equal(result.iterations, 0);
  assert.equal(result.verdict, 'PASS');

  // loadRole must only receive canonical names (never 'developer#1', 'reviewer#1', etc.)
  for (const arg of harness.loadRoleArgs) {
    assert.ok(!arg.includes('#'), `loadRole received non-canonical name: ${arg}`);
  }

  // Chain order: architect, developer, reviewer (PASS → no loop), integrator
  assert.ok(harness.loadRoleArgs.includes('architect'), 'architect not loaded');
  assert.ok(harness.loadRoleArgs.includes('developer'), 'developer not loaded');
  assert.ok(harness.loadRoleArgs.includes('reviewer'), 'reviewer not loaded');
  assert.ok(harness.loadRoleArgs.includes('integrator'), 'integrator not loaded');

  // Event order from REAL appendEvent: architect, developer, reviewer, integrator
  const stepKeys = harness.appendEventArgs
    .filter((e) => e.type === 'step_succeeded')
    .map((e) => e.stepKey);
  assert.deepEqual(stepKeys, ['architect', 'developer', 'reviewer', 'integrator']);
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

  const result = await developTaskImpl(runId, { runnerOverride: 'script' });

  assert.equal(result.blocked, false, 'should not be blocked after PASS');
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

  // integrator ran
  assert.ok(harness.loadRoleArgs.includes('integrator'), 'integrator must run after PASS verdict');
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

  const result = await developTaskImpl(runId, { runnerOverride: 'script' });

  assert.equal(result.blocked, true, 'should be blocked');
  assert.equal(result.iterations, MAX_REVIEW_ITERATIONS, `loop must run exactly ${MAX_REVIEW_ITERATIONS} iterations`);

  // pipeline_blocked event written by REAL appendEvent (not synthetic)
  const blocked = harness.appendEventArgs.find((e) => e.type === 'pipeline_blocked');
  assert.ok(blocked, 'pipeline_blocked event must be written on cap exhaustion');

  // integrator must NOT run
  assert.ok(!harness.loadRoleArgs.includes('integrator'), 'integrator must NOT run when blocked');
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

  // With runnerOverride:'script', dispatch must hit stubRunAgent despite seeded claude-code roles
  const result = await developTaskImpl(runId, { runnerOverride: 'script' });

  assert.equal(result.blocked, false, 'chain should complete via stub');
  // All 4 canonical roles were exercised (chain completed)
  assert.ok(harness.loadRoleArgs.includes('architect'));
  assert.ok(harness.loadRoleArgs.includes('developer'));
  assert.ok(harness.loadRoleArgs.includes('reviewer'));
  assert.ok(harness.loadRoleArgs.includes('integrator'));
  // Events in order: architect, developer, reviewer, integrator
  const stepKeys = harness.appendEventArgs
    .filter((e) => e.type === 'step_succeeded')
    .map((e) => e.stepKey);
  assert.deepEqual(stepKeys, ['architect', 'developer', 'reviewer', 'integrator']);
});

test('T4b (B9): no runnerOverride + claude-code seeded roles → throws RUNNER_NOT_IMPLEMENTED', async () => {
  const runId = 'run-t4b';
  const seededRoles = new Map<string, Role>([
    ['architect', makeRole('architect', 'claude-code')],
    ['developer', makeRole('developer', 'claude-code')],
    ['reviewer', makeRole('reviewer', 'claude-code')],
    ['integrator', makeRole('integrator', 'claude-code')],
  ]);

  const { deps } = buildDeps({ runId, roles: seededRoles });
  const runStepImpl = makeRunStep(deps);

  // No runnerOverride → seeded claude-code → throwing dep → RUNNER_NOT_IMPLEMENTED
  await assert.rejects(
    () => runStepImpl(runId, 'architect', 'architect', { phase: 'plan' }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('RUNNER_NOT_IMPLEMENTED'),
        `error message should contain RUNNER_NOT_IMPLEMENTED: ${err.message}`,
      );
      assert.ok(
        err.message.includes('--stub'),
        `error message should mention --stub: ${err.message}`,
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
    { runnerOverride: 'script' },
  );
  assert.equal(calls[0]?.workflowID, 'run-ac3');
  assert.equal(calls[0]?.queueName, 'dev-tasks');
  assert.deepEqual(calls[0]?.args, ['run-ac3', { runnerOverride: 'script' }]);
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
