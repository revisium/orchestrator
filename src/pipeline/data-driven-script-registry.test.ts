import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemScriptRegistry } from './data-driven-task.workflow.js';
import type { DataDrivenTaskDeps } from './data-driven-task.workflow.js';
import type { AppendEventInput } from '../run/append-event.js';
import type { RouteRoleBinding } from './route-contract.js';
import { PR_LIFECYCLE_NODES } from '../control-plane/run-profiles.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  MergeOverrideOutput,
  RespondThreadsOutput,
} from '../runners/integrator.js';

type ScriptRegistryDeps = Pick<
  DataDrivenTaskDeps,
  | 'appendEvent'
  | 'releaseWorktreeFn'
  | 'integrateFn'
  | 'confirmMergeFn'
  | 'pollPrFn'
  | 'overrideMergeFn'
  | 'respondThreadsFn'
>;

const RUN_ID = 'run-registry-test';
const TASK_ID = 'task-1';
const CTX = { taskId: TASK_ID, title: 'T', base: 'main' } as const;

function makeDecision(scriptRef: string, nodeId = 'scriptNode') {
  return { type: 'invokeScript' as const, scriptRef, nodeId, input: {} };
}

/** Script binding used by script node registry tests. */
function realBinding(): RouteRoleBinding {
  return { roleId: 'integrator', rowId: 'integrator', modelLevel: 'standard', runnerId: 'script', resolvedRunnerId: 'script', runnerSource: 'playbook' };
}

function makeBindings(opts: { ref: string; binding: RouteRoleBinding }): Map<string, RouteRoleBinding> {
  const m = new Map<string, RouteRoleBinding>();
  m.set(opts.ref, opts.binding);
  m.set('script:integrator', opts.binding);
  return m;
}

type DepOverrides = {
  integrateFn?: ScriptRegistryDeps['integrateFn'];
  confirmMergeFn?: ScriptRegistryDeps['confirmMergeFn'];
  pollPrFn?: ScriptRegistryDeps['pollPrFn'];
  overrideMergeFn?: ScriptRegistryDeps['overrideMergeFn'];
  respondThreadsFn?: ScriptRegistryDeps['respondThreadsFn'];
  releaseWorktreeFn?: ScriptRegistryDeps['releaseWorktreeFn'];
};

function buildDeps(events: AppendEventInput[], overrides: DepOverrides = {}): ScriptRegistryDeps {
  return {
    appendEvent: async (e) => { events.push(e); },
    releaseWorktreeFn: overrides.releaseWorktreeFn ?? (async () => ({ released: true, worktreePath: '/fake/worktree' })),
    integrateFn: overrides.integrateFn ?? (async (_: IntegratorInput): Promise<IntegratorOutput> => ({
      prUrl: 'https://example/pr/1', branch: 'feat/x', prNumber: 1, headSha: 'sha1', status: 'pushed',
    })),
    confirmMergeFn: overrides.confirmMergeFn ?? (async (_: IntegratorInput): Promise<ConfirmMergeOutput> => ({
      merged: true, prNumber: 1, prUrl: 'https://example/pr/1/merged',
    })),
    pollPrFn: overrides.pollPrFn ?? (async (_: IntegratorInput): Promise<PrFeedback> => ({
      prNumber: 1, headSha: 'sha1', verdict: 'clean', evidence: ['ok'], ciFailures: [], reviewThreads: [],
    })),
    overrideMergeFn: overrides.overrideMergeFn ?? (async (_: IntegratorInput): Promise<MergeOverrideOutput> => ({
      prNumber: 1,
      headSha: 'sha1',
      verdict: 'clean',
      evidence: ['override accepted'],
      ciFailures: [],
      reviewThreads: [],
      override: { accepted: true, actor: 'test', note: 'test override', source: { gate: 'mergeGate', inboxId: 'inbox-test' }, facts: [], replied: 0, resolved: 0 },
    })),
    respondThreadsFn: overrides.respondThreadsFn ?? (async (_: IntegratorInput): Promise<RespondThreadsOutput> => ({ replied: 2, resolved: 1 })),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// cleanupWorktree
// ──────────────────────────────────────────────────────────────────────────────

test('registry: cleanupWorktree releases worktree, emits worktree_released, returns ok', async () => {
  const events: AppendEventInput[] = [];
  let released = false;
  const deps = buildDeps(events, {
    releaseWorktreeFn: async () => {
      released = true;
      return { released: true, worktreePath: '/fake/worktree' };
    },
  });
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

test('registry: cleanupWorktree emits cleanup_failed when releaseWorktreeFn preserves a dirty worktree', async () => {
  const events: AppendEventInput[] = [];
  const worktreePath = '/fake/worktree/dirty-run';
  const deps = buildDeps(events, {
    releaseWorktreeFn: async () => ({ released: false, reason: 'dirty', worktreePath }),
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:cleanupWorktree')!;

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:cleanupWorktree'), ctx: CTX, bindingByRef: new Map(), stepKey: 'cleanupWorktree', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.deepEqual((result as { outcome: 'ok'; pointer: unknown }).pointer, { released: false, reason: 'dirty', worktreePath });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'cleanup_failed');
  assert.equal(events[0].stepKey, 'cleanupWorktree');
  assert.deepEqual(events[0].payload, { nodeId: 'scriptNode', released: false, reason: 'dirty', worktreePath });
});

test('registry: cleanupWorktree emits cleanup_failed when releaseWorktreeFn throws', async () => {
  const events: AppendEventInput[] = [];
  const deps = buildDeps(events, { releaseWorktreeFn: async () => { throw new Error('disk error'); } });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:cleanupWorktree')!;

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:cleanupWorktree'), ctx: CTX, bindingByRef: new Map(), stepKey: 'cleanupWorktree', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.deepEqual((result as { outcome: 'ok'; pointer: unknown }).pointer, { released: false, error: 'disk error' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'cleanup_failed');
  assert.equal(events[0].stepKey, 'cleanupWorktree');
  assert.deepEqual(events[0].payload, { nodeId: 'scriptNode', error: 'disk error', released: false });
});

// ──────────────────────────────────────────────────────────────────────────────
// script:integrator — event shape, pointer shape, and launch bindings
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:integrator uses real fn without runner binding', async () => {
  const events: AppendEventInput[] = [];
  let realCalled = false;
  const deps = buildDeps(events, {
    integrateFn: async (): Promise<IntegratorOutput> => { realCalled = true; return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1, headSha: 'sha1', status: 'pushed' }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: new Map(), stepKey: 'integrator', inputs: {} });

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
  assert.notEqual(pointer, payload, 'pointer and payload must be separate object instances');
});

test('registry: script:integrator emits foreign_pr_adopted for foreign noop adoption', async () => {
  const events: AppendEventInput[] = [];
  const deps = buildDeps(events, {
    integrateFn: async (): Promise<IntegratorOutput> => ({
      prUrl: 'https://r/pr/17',
      branch: 'feat/x',
      prNumber: 17,
      headSha: 'sha1',
      status: 'noop',
      foreignPr: true,
      prAuthor: 'developer-host',
      integratorAccount: 'profile-bot',
    } as IntegratorOutput),
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({ ref: 'script:integrator', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'foreign_pr_adopted');
  assert.equal(events[0].stepKey, 'integrator');
  const payload = events[0].payload as Record<string, unknown>;
  assert.equal(payload.prNumber, 17);
  assert.equal(payload.headSha, 'sha1');
  assert.equal(payload.status, 'noop');
  assert.equal(payload.prAuthor, 'developer-host');
  assert.equal(payload.integratorAccount, 'profile-bot');
  const pointer = (result as { outcome: 'ok'; pointer: unknown }).pointer as Record<string, unknown>;
  assert.deepEqual(pointer, payload);
  assert.notEqual(pointer, payload, 'pointer and payload must be separate object instances');
});

test('registry: script:integrator does not switch to stub through runner binding', async () => {
  const events: AppendEventInput[] = [];
  let realCalled = false;
  const deps = buildDeps(events, {
    integrateFn: async (): Promise<IntegratorOutput> => { realCalled = true; return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1 }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;
  const bindings = makeBindings({
    ref: 'script:integrator',
    binding: {
      roleId: 'integrator',
      rowId: 'integrator',
      modelLevel: 'standard',
      runnerId: 'stub-agent',
      resolvedRunnerId: 'script',
      runnerSource: 'playbook',
    },
  });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:integrator'), ctx: CTX, bindingByRef: bindings, stepKey: 'integrator', inputs: {} });

  assert.ok(realCalled, 'real integrateFn was invoked');
  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'integrate_succeeded');
});

test('registry: script:integrator passes GitHub account from node launch binding', async () => {
  let seenInput: IntegratorInput | undefined;
  const deps = buildDeps([], {
    integrateFn: async (input): Promise<IntegratorOutput> => {
      seenInput = input;
      return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1 };
    },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:integrator')!;

  await handler({
    runId: RUN_ID,
    decision: makeDecision('script:integrator', 'integrator'),
    ctx: CTX,
    bindingByRef: new Map(),
    launchBindings: [{ match: { nodeId: 'integrator' }, accounts: { github: 'profile-bot' } }],
    stepKey: 'integrator',
    inputs: {},
  });

  assert.equal(seenInput?.githubAccount, 'profile-bot');
});

test('registry: PR lifecycle scripts receive GitHub account from their node launch binding', async () => {
  const seen = new Map<string, string | undefined>();
  const deps = buildDeps([], {
    integrateFn: async (input): Promise<IntegratorOutput> => {
      seen.set(input.title, input.githubAccount);
      return { prUrl: 'https://r/pr/1', branch: 'feat/x', prNumber: 1 };
    },
    confirmMergeFn: async (input): Promise<ConfirmMergeOutput> => {
      seen.set(input.title, input.githubAccount);
      return { merged: true, prNumber: 1, prUrl: 'https://r/pr/1' };
    },
    pollPrFn: async (input): Promise<PrFeedback> => {
      seen.set(input.title, input.githubAccount);
      return { prNumber: 1, headSha: 'sha1', verdict: 'clean', evidence: ['ok'], ciFailures: [], reviewThreads: [] };
    },
    overrideMergeFn: async (input): Promise<MergeOverrideOutput> => {
      seen.set(input.title, input.githubAccount);
      return {
        prNumber: 1,
        headSha: 'sha1',
        verdict: 'clean',
        evidence: ['ok'],
        ciFailures: [],
        reviewThreads: [],
        override: { accepted: true, actor: 'test', note: 'ok', source: { gate: 'mergeGate', inboxId: 'inbox' }, facts: [], replied: 0, resolved: 0 },
      };
    },
    respondThreadsFn: async (input): Promise<RespondThreadsOutput> => {
      seen.set(input.title, input.githubAccount);
      return { replied: 0, resolved: 0 };
    },
  });
  const registry = buildSystemScriptRegistry(deps);
  const scriptRefByNode = new Map<string, string>([
    ['integrator', 'script:integrator'],
    ['reviewIntegrator', 'script:integrator'],
    ['questionReviewIntegrator', 'script:integrator'],
    ['pollPr', 'script:pollPr'],
    ['mergeReadiness', 'script:pollPr'],
    ['mergeRecheck', 'script:pollPr'],
    ['mergeApproveReverify', 'script:pollPr'],
    ['confirmMerge', 'script:confirmMerge'],
    ['overrideConfirmMerge', 'script:confirmMerge'],
    ['overrideMerge', 'script:overrideMerge'],
    ['respondThreads', 'script:respondThreads'],
  ]);
  const launchBindings = PR_LIFECYCLE_NODES.map((nodeId) => ({
    match: { nodeId },
    accounts: { github: 'profile-bot' },
  }));

  for (const nodeId of PR_LIFECYCLE_NODES) {
    const scriptRef = scriptRefByNode.get(nodeId);
    assert.ok(scriptRef, `${nodeId} has a scriptRef mapping`);
    const handler = registry.get(scriptRef)!;
    await handler({
      runId: RUN_ID,
      decision: makeDecision(scriptRef, nodeId),
      ctx: { ...CTX, title: nodeId },
      bindingByRef: new Map(),
      launchBindings,
      stepKey: nodeId,
      inputs: {},
    });
  }

  for (const nodeId of PR_LIFECYCLE_NODES) {
    assert.equal(seen.get(nodeId), 'profile-bot', `${nodeId} receives githubAccount`);
  }
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
// script:overrideMerge
// ──────────────────────────────────────────────────────────────────────────────

test('registry: script:overrideMerge accepted event preserves normalized audit fields', async () => {
  const events: AppendEventInput[] = [];
  const overrideResult: MergeOverrideOutput = {
    prNumber: 42,
    headSha: 'audit-head',
    verdict: 'clean',
    evidence: ['override accepted'],
    ciFailures: [],
    reviewThreads: [],
    override: {
      accepted: true,
      actor: 'reviewer',
      note: 'operator note',
      audit: {
        reason: 'known advisory issue accepted',
        risk: 'advisory concern remains',
        verificationResponsibility: 'operator verified locally',
        headSha: 'audit-head',
      },
      source: { gate: 'mergeGate', inboxId: 'inbox-42' },
      facts: [{ severity: 'advisory', kind: 'review_thread', summary: 'thread accepted', threadId: 'T1' }],
      replied: 1,
      resolved: 1,
    },
  };
  const deps = buildDeps(events, { overrideMergeFn: async () => overrideResult });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:overrideMerge')!;
  const bindings = makeBindings({ ref: 'script:overrideMerge', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:overrideMerge'), ctx: CTX, bindingByRef: bindings, stepKey: 'overrideMerge', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'threads_responded');
  assert.equal(events[1].type, 'merge_overridden');
  assert.deepEqual(events[1].payload, {
    actor: 'reviewer',
    note: 'operator note',
    reason: 'known advisory issue accepted',
    risk: 'advisory concern remains',
    verificationResponsibility: 'operator verified locally',
    headSha: 'audit-head',
    freshHeadSha: 'audit-head',
    prNumber: 42,
    source: { gate: 'mergeGate', inboxId: 'inbox-42' },
    overriddenFacts: [{ severity: 'advisory', kind: 'review_thread', summary: 'thread accepted', threadId: 'T1' }],
    replied: 1,
    resolved: 1,
  });
});

test('registry: script:overrideMerge refused event preserves audit fields and refusal reason separately', async () => {
  const events: AppendEventInput[] = [];
  const overrideResult: MergeOverrideOutput = {
    prNumber: 42,
    headSha: 'fresh-head',
    verdict: 'recheck',
    evidence: ['override refused'],
    ciFailures: [],
    reviewThreads: [],
    override: {
      accepted: false,
      actor: 'reviewer',
      note: 'operator note',
      audit: {
        reason: 'known advisory issue accepted',
        risk: 'advisory concern remains',
        verificationResponsibility: 'operator verified locally',
        headSha: 'audit-head',
      },
      source: { gate: 'mergeGate', inboxId: 'inbox-42' },
      facts: [{ severity: 'hard', kind: 'head_moved', summary: 'head moved' }],
      replied: 0,
      resolved: 0,
      reason: 'override_merge refused because hard blockers remain',
    },
  };
  const deps = buildDeps(events, { overrideMergeFn: async () => overrideResult });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:overrideMerge')!;
  const bindings = makeBindings({ ref: 'script:overrideMerge', binding: realBinding() });

  const result = await handler({ runId: RUN_ID, decision: makeDecision('script:overrideMerge'), ctx: CTX, bindingByRef: bindings, stepKey: 'overrideMerge', inputs: {} });

  assert.equal(result.outcome, 'ok');
  assert.equal(events[0].type, 'merge_override_refused');
  assert.deepEqual(events[0].payload, {
    actor: 'reviewer',
    note: 'operator note',
    reason: 'known advisory issue accepted',
    risk: 'advisory concern remains',
    verificationResponsibility: 'operator verified locally',
    headSha: 'audit-head',
    freshHeadSha: 'fresh-head',
    prNumber: 42,
    source: { gate: 'mergeGate', inboxId: 'inbox-42' },
    overriddenFacts: [{ severity: 'hard', kind: 'head_moved', summary: 'head moved' }],
    replied: 0,
    resolved: 0,
    refusalReason: 'override_merge refused because hard blockers remain',
  });
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
test('registry: script handlers execute without script:integrator binding fallback', async () => {
  const events: AppendEventInput[] = [];
  let realCalled = false;
  const deps = buildDeps(events, {
    confirmMergeFn: async (): Promise<ConfirmMergeOutput> => { realCalled = true; return { merged: true, prNumber: 1, prUrl: 'u' }; },
  });
  const registry = buildSystemScriptRegistry(deps);
  const handler = registry.get('script:confirmMerge')!;

  const bindings = new Map<string, RouteRoleBinding>();
  bindings.set('script:integrator', realBinding());

  await handler({ runId: RUN_ID, decision: makeDecision('script:confirmMerge'), ctx: CTX, bindingByRef: bindings, stepKey: 'confirmMerge', inputs: {} });

  assert.ok(realCalled, 'script handler uses its own real fn');
});

test('registry: unknown script refs are not integrator aliases', () => {
  const registry = buildSystemScriptRegistry(buildDeps([]));
  assert.equal(registry.get('script:unknownScript'), undefined);
});
