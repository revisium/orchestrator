import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemScriptRegistry } from './data-driven-task.workflow.js';
import type { DataDrivenTaskDeps } from './data-driven-task.workflow.js';
import type { AppendEventInput } from '../run/append-event.js';
import type { RouteRoleBinding } from './route-contract.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  RespondThreadsOutput,
} from '../runners/integrator.js';

type ScriptRegistryDeps = Pick<
  DataDrivenTaskDeps,
  | 'appendEvent'
  | 'releaseWorktreeFn'
  | 'integrateFn'
  | 'runStub'
  | 'confirmMergeFn'
  | 'runConfirmStub'
  | 'pollPrFn'
  | 'runPollStub'
  | 'respondThreadsFn'
  | 'runRespondStub'
>;

const RUN_ID = 'run-registry-test';
const TASK_ID = 'task-1';
const CTX = { taskId: TASK_ID, title: 'T', base: 'main' } as const;

function makeDecision(scriptRef: string, nodeId = 'scriptNode') {
  return { type: 'invokeScript' as const, scriptRef, nodeId, input: {} };
}

/** Binding that resolves to a real integrator runner. */
function realBinding(): RouteRoleBinding {
  return { roleId: 'integrator', rowId: 'integrator', modelLevel: 'standard', runnerId: 'revo-integrator', resolvedRunnerId: 'revo-integrator', runnerSource: 'playbook' };
}

/** Binding that resolves to a stub runner. */
function stubBinding(): RouteRoleBinding {
  return { roleId: 'integrator', rowId: 'integrator', modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId: 'claude-code', runnerSource: 'playbook' };
}

function makeBindings(opts: { ref: string; binding: RouteRoleBinding }): Map<string, RouteRoleBinding> {
  const m = new Map<string, RouteRoleBinding>();
  m.set(opts.ref, opts.binding);
  m.set('script:integrator', opts.binding);
  return m;
}

type DepOverrides = {
  integrateFn?: ScriptRegistryDeps['integrateFn'];
  runStub?: ScriptRegistryDeps['runStub'];
  confirmMergeFn?: ScriptRegistryDeps['confirmMergeFn'];
  runConfirmStub?: ScriptRegistryDeps['runConfirmStub'];
  pollPrFn?: ScriptRegistryDeps['pollPrFn'];
  runPollStub?: ScriptRegistryDeps['runPollStub'];
  respondThreadsFn?: ScriptRegistryDeps['respondThreadsFn'];
  runRespondStub?: ScriptRegistryDeps['runRespondStub'];
  releaseWorktreeFn?: ScriptRegistryDeps['releaseWorktreeFn'];
};

function buildDeps(events: AppendEventInput[], overrides: DepOverrides = {}): ScriptRegistryDeps {
  return {
    appendEvent: async (e) => { events.push(e); },
    releaseWorktreeFn: overrides.releaseWorktreeFn ?? (async () => {}),
    integrateFn: overrides.integrateFn ?? (async (_: IntegratorInput): Promise<IntegratorOutput> => ({
      prUrl: 'https://example/pr/1', branch: 'feat/x', prNumber: 1, headSha: 'sha1', status: 'pushed',
    })),
    runStub: overrides.runStub ?? ((_: IntegratorInput): IntegratorOutput => ({
      prUrl: 'stub://pr/0', branch: 'feat/stub', prNumber: 0,
    })),
    confirmMergeFn: overrides.confirmMergeFn ?? (async (_: IntegratorInput): Promise<ConfirmMergeOutput> => ({
      merged: true, prNumber: 1, prUrl: 'https://example/pr/1/merged',
    })),
    runConfirmStub: overrides.runConfirmStub ?? ((_: IntegratorInput): ConfirmMergeOutput => ({
      merged: true, prNumber: 0, prUrl: 'stub://pr/0/merged',
    })),
    pollPrFn: overrides.pollPrFn ?? (async (_: IntegratorInput): Promise<PrFeedback> => ({
      prNumber: 1, headSha: 'sha1', verdict: 'clean', evidence: ['ok'], ciFailures: [], reviewThreads: [],
    })),
    runPollStub: overrides.runPollStub ?? ((_: IntegratorInput): PrFeedback => ({
      prNumber: 0, headSha: 'stub', verdict: 'clean', evidence: [], ciFailures: [], reviewThreads: [],
    })),
    respondThreadsFn: overrides.respondThreadsFn ?? (async (_: IntegratorInput): Promise<RespondThreadsOutput> => ({ replied: 2, resolved: 1 })),
    runRespondStub: overrides.runRespondStub ?? ((_: IntegratorInput): RespondThreadsOutput => ({ replied: 0, resolved: 0 })),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// cleanupWorktree
// ──────────────────────────────────────────────────────────────────────────────

test('registry: cleanupWorktree releases worktree, emits worktree_released, returns ok', async () => {
  const events: AppendEventInput[] = [];
  let released = false;
  const deps = buildDeps(events, { releaseWorktreeFn: async () => { released = true; } });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:cleanupWorktree')!;

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:cleanupWorktree'), ctx: CTX, bindingByRef: new Map(), stepKey: 'cleanupWorktree', inputs: {} });

  assert.ok(released, 'releaseWorktreeFn was called');
  assert.equal(result.outcome, 'ok');
  assert.deepEqual((result as { outcome: 'ok'; pointer: unknown }).pointer, { released: true });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'worktree_released');
  assert.equal(events[0].stepKey, 'cleanupWorktree');
  assert.deepEqual(events[0].payload, { nodeId: 'scriptNode' });
});

test('registry: cleanupWorktree swallows a throwing releaseWorktreeFn and still emits event', async () => {
  const events: AppendEventInput[] = [];
  const deps = buildDeps(events, { releaseWorktreeFn: async () => { throw new Error('disk error'); } });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:cleanupWorktree')!;

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:cleanupWorktree'), ctx: CTX, bindingByRef: new Map(), stepKey: 'cleanupWorktree', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events.length, 1, 'event still emitted despite throw');
  assert.equal(events[0].type, 'worktree_released');
});

// ──────────────────────────────────────────────────────────────────────────────
// script:integrator — real vs stub selection, event shape, pointer shape
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:integrator uses real fn when binding resolves to revo-integrator', async () => {
  const events: AppendEventInput[] = [];
  let realCalled = false;
  const deps = buildDeps(events, {
    integrateFn: async (): Promise<IntegratorOutput> => { realCalled = true; return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1, headSha: 'sha1', status: 'pushed' }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:integrator', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.ok(realCalled, 'real integrateFn was invoked');
  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'integrate_succeeded');
  assert.equal(events[0].stepKey, 'integrator');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.prUrl, 'https://r/pr/1');
  assert.equal(payload.prNumber, 1);
  assert.equal(payload.headSha, 'sha1');
  assert.equal(payload.status, 'pushed');
  const pointer = (result as { outcome: 'ok'; pointer: unknown }).pointer as Record<string, unknown>;
  assert.equal(pointer.prUrl, 'https://r/pr/1');
  assert.equal(pointer.branch, 'feat/x');
});

test('registry: script:integrator uses stub fn when binding resolves to claude-code', async () => {
  const events: AppendEventInput[] = [];
  let stubCalled = false;
  const deps = buildDeps(events, {
    runStub: (): IntegratorOutput => { stubCalled = true; return { prUrl: 'stub://pr/0', branch: 'feat/stub', prNumber: 0 }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:integrator', binding: stubBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.ok(stubCalled, 'stub runStub was invoked');
  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'integrate_succeeded');
});

test('registry: script:integrator needsHuman → pipeline_blocked at stepKey pipeline with reason=integrate', async () => {
  const events: AppendEventInput[] = [];
  const blocked: IntegratorBlocked = { needsHuman: true, lesson: 'test lesson' };
  const deps = buildDeps(events, { integrateFn: async () => blocked });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:integrator', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator', 'intNode'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.equal(result.outcome, 'blocked');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pipeline_blocked');
  assert.equal(events[0].stepKey, 'pipeline');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.reason, 'integrate');
  assert.equal(payload.lesson, 'test lesson');
  assert.equal(payload.nodeId, 'intNode');
});

test('registry: script:integrator throwing fn → step_failed at node stepKey → outcome:failed', async () => {
  const events: AppendEventInput[] = [];
  const deps = buildDeps(events, { integrateFn: async () => { throw new Error('git push failed'); } });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:integrator', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.equal(result.outcome, 'failed');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'step_failed');
  assert.equal(events[0].stepKey, 'integrator');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.scriptRef, 'script:integrator');
  assert.equal(payload.error, 'git push failed');
});

// ──────────────────────────────────────────────────────────────────────────────
// script:confirmMerge
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:confirmMerge success emits merge_confirmed with correct shape', async () => {
  const events: AppendEventInput[] = [];
  const deps = buildDeps(events, {
    confirmMergeFn: async (): Promise<ConfirmMergeOutput> => ({ merged: true, prNumber: 42, prUrl: 'https://r/pr/42' }),
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:confirmMerge')!;
  const bindings = makeBindings({ ref: 'script:confirmMerge', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:confirmMerge'), ctx: CTX, bindingByRef: bindings, stepKey: 'confirmMerge', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'merge_confirmed');
  assert.equal(events[0].stepKey, 'confirmMerge');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.prNumber, 42);
  assert.equal(payload.prUrl, 'https://r/pr/42');
  const pointer = (result as { outcome: 'ok'; pointer: unknown }).pointer as Record<string, unknown>;
  assert.equal(pointer.merged, true);
  assert.equal(pointer.prNumber, 42);
});

test('registry: script:confirmMerge needsHuman → pipeline_blocked with reason=confirm-merge', async () => {
  const events: AppendEventInput[] = [];
  const blocked: IntegratorBlocked = { needsHuman: true, lesson: 'not merged yet' };
  const deps = buildDeps(events, { confirmMergeFn: async () => blocked });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:confirmMerge')!;
  const bindings = makeBindings({ ref: 'script:confirmMerge', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:confirmMerge', 'cmNode'), ctx: CTX, bindingByRef: bindings, stepKey: 'confirmMerge', inputs: {} });

  assert.equal(result.outcome, 'blocked');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.reason, 'confirm-merge');
  assert.equal(payload.stepKey, undefined, 'pipeline_blocked is emitted at stepKey=pipeline not at node stepKey');
  assert.equal(events[0].stepKey, 'pipeline');
  assert.equal(payload.nodeId, 'cmNode');
});

// ──────────────────────────────────────────────────────────────────────────────
// script:pollPr — verdict propagation
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:pollPr propagates verdict from PrFeedback', async () => {
  const events: AppendEventInput[] = [];
  const feedback: PrFeedback = { prNumber: 5, headSha: 'abc', verdict: 'ci_changes', evidence: ['CI failed'], ciFailures: [{ name: 'build', conclusion: 'failure' }], reviewThreads: [] };
  const deps = buildDeps(events, { pollPrFn: async () => feedback });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:pollPr')!;
  const bindings = makeBindings({ ref: 'script:pollPr', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:pollPr'), ctx: CTX, bindingByRef: bindings, stepKey: 'pollPr', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal((result as { outcome: 'ok'; verdict?: string }).verdict, 'ci_changes');
  assert.equal(events[0].type, 'pr_polled');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.verdict, 'ci_changes');
  assert.equal(payload.ciFailures, 1, 'ciFailures is length not array');
  assert.equal(payload.reviewThreads, 0);
  const pointer = (result as { outcome: 'ok'; pointer: unknown }).pointer;
  assert.deepEqual(pointer, feedback, 'pointer is full PrFeedback');
});

test('registry: script:pollPr needsHuman → pipeline_blocked with reason=poll-pr', async () => {
  const events: AppendEventInput[] = [];
  const blocked: IntegratorBlocked = { needsHuman: true, lesson: 'pr missing' };
  const deps = buildDeps(events, { pollPrFn: async () => blocked });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:pollPr')!;
  const bindings = makeBindings({ ref: 'script:pollPr', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:pollPr', 'ppNode'), ctx: CTX, bindingByRef: bindings, stepKey: 'pollPr', inputs: {} });

  assert.equal(result.outcome, 'blocked');
  assert.equal(events[0].stepKey, 'pipeline');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.reason, 'poll-pr');
  assert.equal(payload.nodeId, 'ppNode');
});

// ──────────────────────────────────────────────────────────────────────────────
// script:respondThreads
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:respondThreads success emits threads_responded with pointer=full output', async () => {
  const events: AppendEventInput[] = [];
  const responded: RespondThreadsOutput = { replied: 3, resolved: 2 };
  const deps = buildDeps(events, { respondThreadsFn: async () => responded });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:respondThreads')!;
  const bindings = makeBindings({ ref: 'script:respondThreads', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:respondThreads'), ctx: CTX, bindingByRef: bindings, stepKey: 'respondThreads', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'threads_responded');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.replied, 3);
  assert.equal(payload.resolved, 2);
  assert.deepEqual((result as { outcome: 'ok'; pointer: unknown }).pointer, responded);
});

test('registry: script:respondThreads needsHuman → pipeline_blocked with reason=respond-threads', async () => {
  const events: AppendEventInput[] = [];
  const blocked: IntegratorBlocked = { needsHuman: true, lesson: 'no threads' };
  const deps = buildDeps(events, { respondThreadsFn: async () => blocked });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:respondThreads')!;
  const bindings = makeBindings({ ref: 'script:respondThreads', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:respondThreads', 'rtNode'), ctx: CTX, bindingByRef: bindings, stepKey: 'respondThreads', inputs: {} });

  assert.equal(result.outcome, 'blocked');
  assert.equal(events[0].stepKey, 'pipeline');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.reason, 'respond-threads');
  assert.equal(payload.nodeId, 'rtNode');
});

// ──────────────────────────────────────────────────────────────────────────────
// Binding lookup: scriptRef-keyed first, script:integrator fallback
// ──────────────────────────────────────────────────────────────────────────────

test('registry: binding lookup keys off decision.scriptRef then falls back to script:integrator', async () => {
  const events: AppendEventInput[] = [];
  let realCalled = false;
  const deps = buildDeps(events, {
    confirmMergeFn: async (): Promise<ConfirmMergeOutput> => { realCalled = true; return { merged: true, prNumber: 1, prUrl: 'u' }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:confirmMerge')!;

  // Only 'script:integrator' binding (not script:confirmMerge), so it falls back
  const bindings = new Map<string, RouteRoleBinding>();
  bindings.set('script:integrator', realBinding());

  await handler({ runId: RUN_ID, decision: makeDecision('script:confirmMerge'), ctx: CTX, bindingByRef: bindings, stepKey: 'confirmMerge', inputs: {} });

  assert.ok(realCalled, 'real fn used via script:integrator fallback binding');
});

// ──────────────────────────────────────────────────────────────────────────────
// Unknown script ref falls back to script:integrator handler
// ──────────────────────────────────────────────────────────────────────────────

test('registry: unknown script:foo ref routes to integrator handler', async () => {
  const events: AppendEventInput[] = [];
  let integrateCalled = false;
  const deps = buildDeps(events, {
    integrateFn: async (): Promise<IntegratorOutput> => { integrateCalled = true; return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1 }; },
  });
  const registry = buildSystemScriptRegistry(deps);

  // Unknown ref — no entry in registry, falls back to script:integrator entry
  const handler = registry.get('script:unknownScript') ?? registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:unknownScript', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:unknownScript'), ctx: CTX, bindingByRef: bindings, stepKey: 'unknownScript', inputs: {} });

  assert.ok(integrateCalled, 'integrator fn was called for unknown ref');
  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'integrate_succeeded');
});
