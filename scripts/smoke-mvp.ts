/**
 * smoke-mvp.ts — pure in-process stub end-to-end smoke (0006, §3.4).
 *
 * Zero external calls: no daemon, no DBOS, no Revisium, no claude, no git, no gh, no network.
 * Drives the REAL makeDevelopTask + makeRunStep production builders with injected fakes,
 * asserts the full script-mode event sequence + BOTH gate parks, deterministic throughout.
 *
 * Usage: pnpm run smoke:mvp
 *
 * What this proves:
 *   - Assertions 1–6: step order, integrate_succeeded payload, plan gate before developer,
 *     merge gate after integrate, runStub called once, integrateFn/preflightFn zero, result PASS.
 *   - Does NOT prove DBOS resume, no-duplicate-PR, or crash recovery — those are covered by
 *     the 0004 gate tests and the human dogfood (§7). We scope assertions to what in-process
 *     fakes can deterministically guarantee.
 *
 * Determinism guard: Date.now / Math.random / fs / child_process / network must not appear here.
 * All IDs are static literals; all fakes are pure in-memory.
 */

import { makeRunStep, makeDevelopTask, type RunStepDeps, type DevelopTaskDeps } from '../src/pipeline/develop-task.workflow.js';
import { createRunAgent } from '../src/worker/runner-dispatch.js';
import { stubRunAgent } from '../src/worker/stub-runner.js';
import { stubIntegrate } from '../src/runners/integrator.js';
import type { Role, ModelProfile } from '../src/control-plane/definitions.js';
import type { Step } from '../src/control-plane/steps.js';
import type { ControlPlaneDataAccess } from '../src/control-plane/data-access.js';
import type { AppendEventInput } from '../src/run/append-event.js';
import type { Decision } from '../src/pipeline/await-human.js';
import type { IntegratorInput } from '../src/runners/integrator.js';

// ─── static IDs (deterministic — no Date.now/Math.random) ────────────────────

const SMOKE_RUN_ID = 'run-smoke-mvp-static';
const SMOKE_TASK_ID = 'task-smoke';

// ─── fakes ────────────────────────────────────────────────────────────────────

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

function makeFakeDa(): ControlPlaneDataAccess {
  const rows: Array<{ table: string; rowId: string; data: Record<string, unknown> }> = [];
  return {
    assertReady: async () => undefined,
    listRows: async () => [],
    getRow: async (table, rowId) => {
      if (table === 'tasks') {
        return { rowId, data: { title: 'Smoke task', scope: '', repo_ref: '' } };
      }
      return null;
    },
    createRow: async (table, rowId, data) => {
      rows.push({ table, rowId, data });
      return { rowId, data };
    },
    updateRow: async (_t, rowId, data) => ({ rowId, data }),
    patchRow: async (_t, rowId, _p) => ({ rowId, data: {} }),
  };
}

// ─── single ordered trace ────────────────────────────────────────────────────
// Both appendEvent and awaitHuman push into ONE trace array in call order so
// positional assertions can compare event positions against gate positions.

type TraceEntry =
  | { kind: 'event'; stepKey: string; type: string; payload?: unknown }
  | { kind: 'gate'; topic: 'plan' | 'merge'; summary: unknown };

const trace: TraceEntry[] = [];

// ─── call counters ────────────────────────────────────────────────────────────

let stubCallCount = 0;
let integrateCallCount = 0;
let preflightCallCount = 0;

// ─── build deps ──────────────────────────────────────────────────────────────

const defaultRoles = new Map<string, Role>([
  ['architect', makeRole('architect')],
  ['developer', makeRole('developer')],
  ['reviewer', makeRole('reviewer')],
  ['integrator', makeRole('integrator')],
]);

const loadRole = async (name: string): Promise<Role> =>
  defaultRoles.get(name) ?? makeRole(name);

const loadModelProfile = async (level: string): Promise<ModelProfile> =>
  makeProfile(level as 'cheap' | 'standard' | 'deep');

const fakeDa = makeFakeDa();

const loadPipelineContext = async (
  rId: string,
  role: string,
  stepKey: string,
  stepInput: unknown,
  modelProfile: string,
): Promise<{ da: ControlPlaneDataAccess; step: Step }> => {
  const step: Step = {
    id: `pstep_smoke_${stepKey}`,
    taskId: SMOKE_TASK_ID,
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
  return { da: fakeDa, step };
};

const appendEvent = async (input: AppendEventInput): Promise<void> => {
  trace.push({ kind: 'event', stepKey: input.stepKey, type: input.type, payload: input.payload });
};

const appendCost = async (): Promise<void> => undefined;

const appendAttempt = async (): Promise<void> => undefined;

// runAgent: REAL createRunAgent with throwing claudeCode + stubRunAgent for script dispatch.
// Cost-safety: in script mode the throwing claudeCode is never reached.
const throwingClaudeCode = async () => {
  throw new Error('RUNNER_NOT_IMPLEMENTED — smoke must use script mode only');
};

const runAgent = createRunAgent({ claudeCode: throwingClaudeCode, script: stubRunAgent });

const runStepDeps: RunStepDeps = {
  loadRole,
  loadModelProfile,
  loadPipelineContext,
  appendEvent,
  appendCost,
  appendAttempt,
  runAgent,
};

// awaitHuman fake: drives BOTH gates deterministically without real DBOS.
const awaitHuman = async (
  _runId: string,
  topic: 'plan' | 'merge',
  _title: string,
  summary: unknown,
): Promise<Decision> => {
  trace.push({ kind: 'gate', topic, summary });
  // Plan gate: approve → continue to developer/reviewer/integrator
  // Merge gate: record (prUrl=stub://) then approve to terminate cleanly
  return { decision: 'approve' };
};

// cancelRun fake (only called on reject; not exercised in the happy-path smoke).
const cancelRun = async () => ({ runId: SMOKE_RUN_ID, previousStatus: 'running' as const, status: 'cancelled' as const });

// failRun fake (only called on a terminal step throw; not exercised in the happy-path smoke).
const failRun = async () => ({ runId: SMOKE_RUN_ID, previousStatus: 'running' as const, status: 'failed' as const });

const loadRunTaskContext = async (_runId: string) => ({
  taskId: SMOKE_TASK_ID,
  title: 'Smoke task',
  base: 'master',
  repoRef: '',
});

// loadPipelinePolicy fake — safe defaults (no budget limit, 3 review iterations).
const loadPipelinePolicy = async () => ({
  maxReviewIterations: 3,
  maxAttempts: 3,
  budgetUsd: 0,
  budgetTokens: 0,
});

const integrateFn = async (_input: IntegratorInput) => {
  integrateCallCount++;
  // Should never be called in script mode — assertion 5 catches this.
  return { prUrl: 'https://github.com/owner/repo/pull/999', branch: 'feat/should-not-happen', prNumber: 999 };
};

const runStub = (input: IntegratorInput) => {
  stubCallCount++;
  return stubIntegrate(input);
};

const preflightFn = async (_taskId: string, _base: string) => {
  preflightCallCount++;
  // Should never be called in script mode — assertion 5 catches this.
  return { ok: true as const };
};

const workflowDeps: DevelopTaskDeps = {
  appendEvent,
  awaitHuman,
  cancelRun,
  failRun,
  loadRunTaskContext,
  loadPipelinePolicy,
  integrateFn,
  runStub,
  preflightFn,
};

// ─── run the smoke ────────────────────────────────────────────────────────────

const runStepImpl = makeRunStep(runStepDeps);
const developTaskImpl = makeDevelopTask(runStepImpl, workflowDeps);

const result = await developTaskImpl(SMOKE_RUN_ID, { runnerMode: 'script' });

// ─── assertions ───────────────────────────────────────────────────────────────

function fail(msg: string): never {
  throw new Error(`smoke:mvp FAILED — ${msg}`);
}

// Helper: find position in the shared trace.
function traceIdx(pred: (e: TraceEntry) => boolean): number {
  return trace.findIndex(pred);
}

// Assertion 1: step_succeeded stepKeys in order [architect, developer, reviewer]
const stepSucceeded = trace
  .filter((e): e is Extract<TraceEntry, { kind: 'event' }> => e.kind === 'event' && e.type === 'step_succeeded')
  .map((e) => e.stepKey);
if (stepSucceeded.length !== 3) {
  fail(`expected 3 step_succeeded events; got ${stepSucceeded.length}: ${JSON.stringify(stepSucceeded)}`);
}
if (JSON.stringify(stepSucceeded) !== JSON.stringify(['architect', 'developer', 'reviewer'])) {
  fail(`step_succeeded order wrong; expected ['architect','developer','reviewer'], got: ${JSON.stringify(stepSucceeded)}`);
}

// Assertion 2: exactly one integrate_succeeded with prUrl === 'stub://pr/placeholder' (exact match).
const integrateSucceeded = trace.filter(
  (e): e is Extract<TraceEntry, { kind: 'event' }> => e.kind === 'event' && e.type === 'integrate_succeeded',
);
if (integrateSucceeded.length !== 1) {
  fail(`expected 1 integrate_succeeded event; got ${integrateSucceeded.length}`);
}
const integratePayload = integrateSucceeded[0]?.payload as Record<string, unknown> | undefined;
const prUrl = typeof integratePayload?.prUrl === 'string' ? integratePayload.prUrl : '';
if (prUrl !== 'stub://pr/placeholder') {
  fail(`integrate_succeeded.prUrl must be exactly 'stub://pr/placeholder'; got: ${prUrl}`);
}

// Assertion 3+4: gate ordering verified against the SINGLE ordered trace.
// architect:step_succeeded < gate:plan < developer:step_succeeded
// integrate_succeeded < gate:merge

const architectTraceIdx = traceIdx((e) => e.kind === 'event' && e.stepKey === 'architect' && e.type === 'step_succeeded');
const planGateTraceIdx = traceIdx((e) => e.kind === 'gate' && e.topic === 'plan');
const developerTraceIdx = traceIdx((e) => e.kind === 'event' && e.stepKey === 'developer' && e.type === 'step_succeeded');
const integrateSucceededTraceIdx = traceIdx((e) => e.kind === 'event' && e.type === 'integrate_succeeded');
const mergeGateTraceIdx = traceIdx((e) => e.kind === 'gate' && e.topic === 'merge');

if (architectTraceIdx === -1) fail('architect:step_succeeded not found in trace');
if (planGateTraceIdx === -1) fail('gate:plan not found in trace');
if (developerTraceIdx === -1) fail('developer:step_succeeded not found in trace');
if (integrateSucceededTraceIdx === -1) fail('integrate_succeeded not found in trace');
if (mergeGateTraceIdx === -1) fail('gate:merge not found in trace');

// architect → plan gate → developer (a gate reorder WILL fail this)
if (!(architectTraceIdx < planGateTraceIdx)) {
  fail(`architect:step_succeeded (${architectTraceIdx}) must precede gate:plan (${planGateTraceIdx}) in trace`);
}
if (!(planGateTraceIdx < developerTraceIdx)) {
  fail(`gate:plan (${planGateTraceIdx}) must precede developer:step_succeeded (${developerTraceIdx}) in trace`);
}

// integrate_succeeded → merge gate
if (!(integrateSucceededTraceIdx < mergeGateTraceIdx)) {
  fail(`integrate_succeeded (${integrateSucceededTraceIdx}) must precede gate:merge (${mergeGateTraceIdx}) in trace`);
}

// Assertion 5: runStub called once; integrateFn and preflightFn called zero times (script mode).
if (stubCallCount !== 1) {
  fail(`runStub must be called exactly once; was called ${stubCallCount} times`);
}
if (integrateCallCount !== 0) {
  fail(`integrateFn must NOT be called in script mode; was called ${integrateCallCount} times`);
}
if (preflightCallCount !== 0) {
  fail(`preflightFn must NOT be called in script mode; was called ${preflightCallCount} times`);
}

// Assertion 6: result {blocked:false, cancelled:false, verdict:'PASS', iterations:0}
if (result.blocked !== false) {
  fail(`result.blocked must be false; got: ${String(result.blocked)}`);
}
if (result.cancelled !== false) {
  fail(`result.cancelled must be false; got: ${String(result.cancelled)}`);
}
if (result.iterations !== 0) {
  fail(`result.iterations must be 0; got: ${result.iterations}`);
}
if (result.verdict !== 'PASS') {
  fail(`result.verdict must be 'PASS'; got: ${result.verdict}`);
}

// Assertion: both gates were reached
const gateEntries = trace.filter((e): e is Extract<TraceEntry, { kind: 'gate' }> => e.kind === 'gate');
if (gateEntries.length !== 2) {
  fail(`expected 2 gate invocations (plan + merge); got ${gateEntries.length}: ${JSON.stringify(gateEntries.map((g) => g.topic))}`);
}

console.log('smoke:mvp PASSED');
console.log(`  step order:     ${JSON.stringify(stepSucceeded)}`);
console.log(`  integrate prUrl: ${prUrl}`);
console.log(`  gates opened:   ${JSON.stringify(gateEntries.map((g) => g.topic))}`);
console.log(`  stubCallCount:  ${stubCallCount}`);
console.log(`  result:         blocked=${String(result.blocked)} cancelled=${String(result.cancelled)} verdict=${result.verdict}`);
