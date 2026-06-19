/**
 * Unit tests for the DATA-DRIVEN DBOS effect-adapter, exercising the PRODUCTION builder
 * (`makeDataDrivenTask`) directly with fakes — no DBOS, no Revisium (the C1 pattern). PipelineService
 * registers this exact builder, so these tests fail if the adapter's core.step loop, capability
 * resolution, gate mapping, terminal handling, or failure routing regresses.
 *
 * The pure pipeline-core graph is fixed (`featureDevelopment` fixture); the adapter is the unit under
 * test. We script the `runStepFn` per node id and assert which terminal the run reaches + which gates
 * opened, plus that the integrator script + completion verbs were invoked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDataDrivenTask, type DataDrivenTaskDeps } from './data-driven-task.workflow.js';
import { templateFromExecutionPolicy } from './data-driven-template.js';
import { featureDevelopment, featureDevelopmentPrReview, confirmMergeFlow } from '../pipeline-core/kit/fixtures.js';
import type { Template } from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { RouteDecision, RouteRoleBinding } from './route-contract.js';
import type { Decision as GateDecision } from './await-human.js';
import type { IntegratorInput, IntegratorOutput, IntegratorBlocked, ConfirmMergeOutput, PrFeedback, RespondThreadsOutput } from '../runners/integrator.js';
import { template, node, on, otherwise, verdictEq, allOf, counterLt } from '../pipeline-core/kit/index.js';

const RUN_ID = 'run-dd-001';

function binding(roleId: string, resolvedRunnerId = 'script'): RouteRoleBinding {
  return { roleId, rowId: roleId, modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId, runnerSource: 'playbook' };
}

/** A route binding the data-driven feature template's roleRefs/scriptRef resolve against. */
function makeRoute(): RouteDecision {
  return {
    playbookId: 'pb',
    pipelineId: 'feature-development-dd',
    pipelineRowId: 'row',
    source: 'explicit',
    roles: ['analyst', 'developer', 'reviewer', 'triager', 'integrator', 'watcher'],
    requiredRoles: ['analyst', 'developer', 'reviewer', 'triager', 'integrator', 'watcher'],
    optionalRoles: [],
    routeGates: ['plan', 'merge'],
    executionPolicy: {},
    executionProfile: { id: 'test', runnerOverrides: {} },
    roleBindings: [
      binding('analyst'),
      binding('developer'),
      binding('reviewer'),
      binding('triager'),
      binding('integrator', 'revo-integrator'), // real-integrator runner → script:integrator resolves here
      binding('watcher'),
    ],
    params: {},
  };
}

type Recorder = {
  gates: string[];
  completed: Array<{ verdict?: string }>;
  blocked: Array<{ reason?: string }>;
  failed: string[];
  integrateCalls: number;
  confirmMergeCalls: number;
  pollPrCalls: number;
  respondCalls: number;
  /** The triage each respondThreads call consumed (asserts the 0016 script-consumes hydration). */
  respondTriage: unknown[];
  events: string[];
  /** Persisted step outputs (0016 dataflow). */
  outputs: Array<{ nodeId: string; ordinal: number; name: string; payload: unknown }>;
  /** Hydrated `inputs` the adapter passed to each step, keyed by stepKey (0016 consumes). */
  inputsByStep: Record<string, unknown>;
};

/**
 * Build the adapter from a per-node verdict script + a gate decider. `runStepFn` returns the scripted
 * domain verdict for the node id; an absent entry returns a structural PASS-equivalent with no verdict.
 */
function buildAdapter(opts: {
  verdicts?: Record<string, string | string[]>;
  gate?: (topic: 'plan' | 'merge' | 'question') => GateDecision;
  needsHumanNodes?: Set<string>;
  template?: Template;
  /** Override the integrator result (default: success). Lets a test drive needsHuman / throw. */
  integrate?: (input: IntegratorInput) => IntegratorOutput | IntegratorBlocked | Promise<IntegratorOutput | IntegratorBlocked>;
  /** Override the live preflight (default: ok). Lets a test drive a preflight block. */
  preflight?: () => { ok: true } | { needsHuman: true; lesson: string } | Promise<{ ok: true } | { needsHuman: true; lesson: string }>;
  /** Override confirmMerge (default: merged). Lets a test drive a not-merged block. */
  confirmMerge?: (input: IntegratorInput) => ConfirmMergeOutput | IntegratorBlocked | Promise<ConfirmMergeOutput | IntegratorBlocked>;
  /** Override pollPr (default: clean). Lets a test drive review_changes / ci_changes / a block. */
  pollPr?: (input: IntegratorInput) => PrFeedback | IntegratorBlocked | Promise<PrFeedback | IntegratorBlocked>;
  /** Override respondThreads (default: replied/resolved 0). Lets a test capture the triage it consumed. */
  respondThreads?: (input: IntegratorInput) => RespondThreadsOutput | IntegratorBlocked | Promise<RespondThreadsOutput | IntegratorBlocked>;
}) {
  const rec: Recorder = { gates: [], completed: [], blocked: [], failed: [], integrateCalls: 0, confirmMergeCalls: 0, pollPrCalls: 0, respondCalls: 0, respondTriage: [], events: [], outputs: [], inputsByStep: {} };
  const visits = new Map<string, number>();

  const runStepFn = async (
    _runId: string,
    _role: string,
    stepKey: string,
    input: unknown,
  ): Promise<AttemptResult> => {
    // The adapter ordinal-suffixes the stepKey on loop re-entries (0016 §4.1: `nodeId#2`); the verdict
    // script + visit count are keyed by the NODE (a verdict is a property of the role, not the iteration).
    const nodeId = stepKey.includes('#') ? stepKey.slice(0, stepKey.indexOf('#')) : stepKey;
    const n = visits.get(nodeId) ?? 0;
    visits.set(nodeId, n + 1);
    // Capture hydrated consumes (0016) so a test can assert an upstream output reached this step.
    if (input !== null && typeof input === 'object' && 'inputs' in (input as Record<string, unknown>)) {
      rec.inputsByStep[nodeId] = (input as Record<string, unknown>).inputs;
    }
    if (opts.needsHumanNodes?.has(nodeId)) {
      return { output: { verdict: 'BLOCKER' }, nextSteps: [], costs: [], needsHuman: true, lesson: 'parked' };
    }
    const entry = opts.verdicts?.[nodeId];
    const verdict = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] ?? 'approved') : (entry ?? 'approved');
    return { output: { verdict, from: nodeId }, nextSteps: [], costs: [] };
  };

  const deps: DataDrivenTaskDeps = {
    appendEvent: async (e) => { rec.events.push(`${e.type}:${e.stepKey}`); },
    appendRunOutput: async (o) => { rec.outputs.push({ nodeId: o.nodeId, ordinal: o.ordinal, name: o.name, payload: o.payload }); },
    awaitHuman: async (_runId, topic, _gateKey, _title, _summary): Promise<GateDecision> => {
      rec.gates.push(topic);
      return (opts.gate ?? (() => ({ decision: 'approve' })))(topic);
    },
    completeRun: async (_runId, o) => { rec.completed.push({ verdict: o?.verdict }); return null; },
    failRun: async (_runId, reason) => { rec.failed.push(reason); return null; },
    blockRun: async (_runId, o) => { rec.blocked.push({ reason: o?.reason }); return null; },
    loadRunTaskContext: async () => ({ taskId: 'task-1', title: 'T', base: 'master', repoRef: '' }),
    integrateFn: async (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
      rec.integrateCalls++;
      if (opts.integrate) return opts.integrate(input);
      return { prUrl: `https://example/pr/${input.taskId}`, branch: 'feat/x', prNumber: 1 };
    },
    runStub: (input: IntegratorInput): IntegratorOutput => {
      rec.integrateCalls++;
      return { prUrl: 'stub://pr/placeholder', branch: `feat/${input.taskId}-stub`, prNumber: 0 };
    },
    // The test route binds the integrator to revo-integrator (a live runner), so preflight runs. By
    // default it passes (these tests exercise the graph, not preflight); a test can override it.
    preflightFn: async () => (opts.preflight ? opts.preflight() : { ok: true }),
    // Per-run worktree lifecycle (plan 0017) — fakes here record create/release ordering via events;
    // the live runner binding means both fire (create after preflight, release in the terminal finally).
    createWorktreeFn: async () => { rec.events.push('worktree_create:pipeline'); return { worktreePath: '/fake/worktree' }; },
    releaseWorktreeFn: async () => { rec.events.push('worktree_release:pipeline'); },
    // confirmMerge (plan 0017 follow-up): default fake reports merged; a test can override via opts.confirmMerge.
    confirmMergeFn: async (input: IntegratorInput) => {
      rec.confirmMergeCalls++;
      if (opts.confirmMerge) return opts.confirmMerge(input);
      return { merged: true as const, prNumber: 1, prUrl: `https://example/pr/${input.taskId}/merged` };
    },
    runConfirmStub: (input: IntegratorInput) => ({ merged: true as const, prNumber: 0, prUrl: `stub://pr/${input.taskId}/merged` }),
    // pollPr (plan 0018): default fake reports a CLEAN PR so the loop converges to the merge gate.
    pollPrFn: async (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
      rec.pollPrCalls++;
      if (opts.pollPr) return opts.pollPr(input);
      return { prNumber: 1, headSha: 'sha', verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
    runPollStub: (_input: IntegratorInput): PrFeedback => ({ prNumber: 0, headSha: 'stub', verdict: 'clean', ciFailures: [], reviewThreads: [] }),
    // respondThreads (plan 0018): capture the consumed triage; default reports nothing to reply/resolve.
    respondThreadsFn: async (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
      rec.respondCalls++;
      rec.respondTriage.push(input.triage);
      if (opts.respondThreads) return opts.respondThreads(input);
      return { replied: 0, resolved: 0 };
    },
    runRespondStub: (_input: IntegratorInput): RespondThreadsOutput => ({ replied: 0, resolved: 0 }),
  };

  const fn = makeDataDrivenTask(runStepFn, deps);
  const template = opts.template ?? featureDevelopment();
  return { run: () => fn(RUN_ID, { route: makeRoute(), template }), rec };
}

test('DD1: happy path — analyst→plan→developer→review→integrate→pollPr(clean)→merge→confirmMerge → succeeded', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['plan', 'merge'], 'both humanGate nodes opened, in order');
  assert.equal(rec.completed.length, 1, 'completeRun called once');
  assert.equal(rec.integrateCalls, 1, 'the integrator script ran once (real integrator via runner-wins)');
  assert.ok(rec.events.includes('integrate_succeeded:integrator'), 'integrate_succeeded emitted at the script node');
  assert.equal(rec.pollPrCalls, 1, 'pollPr observed the PR once (clean → merge gate)');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge ran once at the success terminal');
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
});

test('DD2: reviewer BLOCKER ×cap → bounded rework loop → blocked terminal (counter cap is DATA)', async () => {
  const { run, rec } = buildAdapter({
    // codeReview always blocker → codeReviewRouter loops to reworkDeveloper until counter.gte(3) → blockedEnd.
    verdicts: { codeReview: 'blocker' },
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'the run blocks at the cap, not the agent');
  assert.equal(rec.completed.length, 0);
  assert.equal(rec.blocked.length, 1, 'blockRun called once');
  assert.equal(rec.gates.length, 1, 'only the plan gate opened (blocked before the merge gate)');
  assert.equal(rec.integrateCalls, 0, 'the integrator never ran (blocked in review)');
});

test('DD3: plan-gate reject maps to the rework outcome — loops back to analyst, then approve proceeds', async () => {
  // Gate semantics are 100% in the routing data (§8): this template declares planGate outcomes
  // [approved, changes_requested] with changes_requested → analyst (a human-driven rework loop, no
  // counter). A human REJECT maps to the declared rework outcome, so the FIRST reject loops back to
  // the analyst and re-opens the plan gate; the SECOND (approve) proceeds. This proves the adapter
  // routes a gate verdict through the template (not a hardcoded cancel).
  let planSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (topic) => {
      if (topic === 'plan') {
        planSeen++;
        return planSeen === 1 ? { decision: 'reject' } : { decision: 'approve' };
      }
      return { decision: 'approve' };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded', 'reject→rework→approve eventually completes');
  assert.equal(planSeen, 2, 'the plan gate opened twice (reject looped back to analyst, then approved)');
  assert.equal(rec.gates.filter((g) => g === 'plan').length, 2, 'analyst re-ran and re-opened the plan gate');
});

test('DD4: pollPr ci_changes → ciRework → re-integrate → pollPr(clean) → merge → succeeded', async () => {
  // First poll reports a CI failure (ci_changes) → ciRework (developer) fixes it → integrator re-pushes →
  // second poll is clean → merge gate → confirmMerge → succeeded. Proves the bounded CI rework loop.
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      polls++;
      return polls === 1
        ? { prNumber: 1, headSha: 's1', verdict: 'ci_changes' as const, ciFailures: [{ name: 'build', conclusion: 'FAILURE' }], reviewThreads: [] }
        : { prNumber: 1, headSha: 's2', verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.equal(rec.pollPrCalls, 2, 'polled twice (ci_changes then clean)');
  assert.equal(rec.integrateCalls, 2, 'integrator ran for the initial PR + the CI re-push');
  // ciRework consumed the prFeedback (0016) — its hydrated input carries the failing-check feedback.
  const ciFeedback = (rec.inputsByStep['ciRework'] as { feedback?: { verdict?: string } } | undefined)?.feedback;
  assert.equal(ciFeedback?.verdict, 'ci_changes', 'ciRework consumed pollPr prFeedback');
});

test('DD4b: pollPr ci_changes forever → cap → blocked terminal (ciLoop is DATA)', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => ({ prNumber: 1, headSha: 's', verdict: 'ci_changes' as const, ciFailures: [{ name: 'build', conclusion: 'FAILURE' }], reviewThreads: [] }),
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'the CI loop blocks at its cap, not the agent');
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.confirmMergeCalls, 0, 'never reached the merge gate');
});

test('DD4c: pollPr review_changes → triage(fix) → reviewRework → integrate → respondThreads → pollPr(clean) → merge', async () => {
  // A review comment routes to triage; the analyst returns `fix`; the developer reworks; the SAME PR is
  // re-pushed (reviewIntegrator) BEFORE respondThreads replies/resolves; the next poll is clean → merge.
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', triage: 'fix' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      polls++;
      return polls === 1
        ? { prNumber: 1, headSha: 's1', verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'fix this' }] }
        : { prNumber: 1, headSha: 's2', verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.equal(rec.respondCalls, 1, 'respondThreads ran once (reply + resolve the fixed thread)');
  assert.equal(rec.integrateCalls, 2, 'integrator ran for the initial PR + the review re-push (reviewIntegrator)');
  // respondThreads consumed the triage produced by the analyst (0016 script-consumes hydration).
  assert.ok(rec.respondTriage.length === 1 && rec.respondTriage[0] !== undefined, 'respondThreads consumed the triage');
});

test('DD4d: pollPr review_changes → triage(question) → questionGate(approve) → triage(wontfix) → respondThreads → pollPr(clean)', async () => {
  // The analyst first marks a thread `question` → the question gate surfaces it; on approve the run loops
  // back to triage, which now returns `wontfix` → respondThreads (reply+resolve, no push) → clean → merge.
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', triage: ['question', 'wontfix'] },
    gate: () => ({ decision: 'approve' }),
    pollPr: (() => {
      let polls = 0;
      return () => {
        polls++;
        return polls === 1
          ? { prNumber: 1, headSha: 's1', verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'why?' }] }
          : { prNumber: 1, headSha: 's2', verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
      };
    })(),
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.ok(rec.gates.includes('plan') && rec.gates.includes('merge'), 'plan + merge gates opened');
  // The question gate is the SEPARATE 'review-question' reason → its OWN 'question' topic (distinct from
  // the plan gate's 'plan' topic, so the real DBOS recv channels never collide — plan 0018).
  assert.equal(rec.respondCalls, 1, 'wontfix path replies + resolves via respondThreads');
  assert.equal(rec.integrateCalls, 1, 'wontfix needs no re-push (integrator ran only for the initial PR)');
});

test('DD5: an effect that needsHuman → resultSchema/abort precedence → failed terminal (onFailure=abort)', async () => {
  const { run, rec } = buildAdapter({
    needsHumanNodes: new Set(['developer']), // developer parks → revo.ResultInvalid; node onFailure=abort
  });
  const result = await run();
  assert.equal(result.status, 'failed', 'an aborting effect failure terminates the run failed');
  assert.equal(rec.failed.length, 1);
  assert.equal(rec.completed.length, 0);
});

test('DD6: an invalid pinned template fails the run loudly (defense-in-depth validation)', async () => {
  const broken = featureDevelopment();
  // Dangle an edge: point analyst.next at a non-existent node → REF_UNRESOLVED.
  (broken.nodes['analyst'] as { next: string }).next = 'nope';
  const { run, rec } = buildAdapter({ template: broken });
  await assert.rejects(() => run(), /PINNED_TEMPLATE_INVALID/);
  assert.equal(rec.failed.length, 1, 'the top-level catch failRuns the run');
});

// ── Integrator script: block (needsHuman) vs fail (throw) discrimination + preflight ──
//
// A minimal template whose integrator carries BOTH catch arms (the slice-3 shape): a needsHuman
// integrator → revo.ScriptBlocked → blocked terminal (surface the reason); a throwing integrator →
// revo.ScriptFailed → failed terminal. (The `featureDevelopment()` fixture only catches ScriptFailed.)
function integratorTemplate(): Template {
  return template('integrator-modes')
    .title('integrator block-vs-fail')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'integrator', { resultSchema: 'schema:change', onFailure: 'abort' }),
      node.script('integrator', 'script:integrator', 'mergedEnd', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        catch: [
          { onError: 'revo.ScriptBlocked', goto: 'blockedEnd' },
          { onError: 'revo.ScriptFailed', goto: 'failedEnd' },
        ],
      }),
      node.terminal('mergedEnd', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
      node.terminal('blockedEnd', 'blocked'),
    )
    .build();
}

test('DD7: an integrator that needsHuman BLOCKS the run (revo.ScriptBlocked → blocked terminal + lesson)', async () => {
  const { run, rec } = buildAdapter({
    template: integratorTemplate(),
    integrate: () => ({ needsHuman: true, lesson: 'nothing to integrate — branch not ahead' }),
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'a needsHuman integrator blocks (does NOT fail)');
  assert.equal(rec.blocked.length, 1, 'blockRun called for the blocked terminal');
  assert.equal(rec.failed.length, 0, 'failRun not called — needsHuman is a block, not a failure');
  assert.ok(
    rec.events.includes('pipeline_blocked:pipeline'),
    'the blocking reason is surfaced as pipeline_blocked (lesson visible to the human)',
  );
});

test('DD8: an integrator that THROWS fails the run (revo.ScriptFailed → failed terminal)', async () => {
  const { run, rec } = buildAdapter({
    template: integratorTemplate(),
    integrate: () => { throw new Error('git push rejected: non-fast-forward'); },
  });
  const result = await run();
  assert.equal(result.status, 'failed', 'a throwing integrator fails the run');
  assert.equal(rec.failed.length, 1, 'failRun called for the failed terminal');
  assert.equal(rec.blocked.length, 0);
});

test('DD9: a live preflight that needsHuman blocks the run BEFORE the graph runs (no steps)', async () => {
  const { run, rec } = buildAdapter({
    template: integratorTemplate(),
    preflight: () => ({ needsHuman: true, lesson: 'target repo is not clean; commit/stash and retry' }),
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'preflight needsHuman blocks the run');
  assert.equal(rec.blocked.length, 1, 'blockRun called');
  assert.equal(rec.integrateCalls, 0, 'the integrator never ran (blocked at preflight)');
  assert.ok(rec.events.includes('pipeline_blocked:pipeline'), 'preflight block surfaces pipeline_blocked');
});

// ── Selection helper (templateFromExecutionPolicy) ────────────────────────────

test('SEL1: a pipeline carrying a valid template_json is detected as data-driven', () => {
  const template = featureDevelopment();
  const got = templateFromExecutionPolicy({ template_json: template });
  assert.ok(got, 'a valid embedded template is returned');
  assert.equal(got.specVersion, '1.0');
});

test('SEL2: a pipeline WITHOUT a template_json is NOT data-driven (→ hardcoded path)', () => {
  assert.equal(templateFromExecutionPolicy({ raw: ['policy text'] }), null);
  assert.equal(templateFromExecutionPolicy({}), null);
  assert.equal(templateFromExecutionPolicy(undefined), null);
});

test('SEL3: a present-but-INVALID template_json throws (fail-loud, never silent-degrade)', () => {
  const broken = featureDevelopment();
  (broken.nodes['analyst'] as { next: string }).next = 'nope';
  assert.throws(() => templateFromExecutionPolicy({ template_json: broken }), /DATA_DRIVEN_TEMPLATE_INVALID/);
  assert.throws(() => templateFromExecutionPolicy({ template_json: '{not json' }), /MALFORMED/);
  assert.throws(() => templateFromExecutionPolicy({ template_json: { foo: 1 } }), /MALFORMED/);
});

test('SEL4: a serialized (string) template_json is parsed + validated', () => {
  const template = featureDevelopment();
  const got = templateFromExecutionPolicy({ template_json: JSON.stringify(template) });
  assert.ok(got);
  assert.equal(got.pipelineId, 'feature-development');
});

// ─────────────────────────────────────────────────────────────────────────────
// 0016 dataflow — produces/consumes hydration, fail-loud missing input, loop ordinals.
// ─────────────────────────────────────────────────────────────────────────────

test('DD-DF1: a producing node persists its output and a consumer is hydrated with it', async () => {
  const tmpl = template('df-dd')
    .specVersion('1.0')
    .entry('analyst')
    .domain('approved')
    .add(
      node.agent('analyst', 'role:analyst', 'developer', { resultSchema: 'schema:plan', produces: { name: 'plan' } }),
      node.agent('developer', 'role:developer', 'done', {
        resultSchema: 'schema:change',
        consumes: [{ node: 'analyst', as: 'plan' }],
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  const { run, rec } = buildAdapter({ template: tmpl });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  // analyst's output persisted once at ordinal 1.
  assert.deepEqual(
    rec.outputs.map((o) => ({ nodeId: o.nodeId, ordinal: o.ordinal, name: o.name })),
    [{ nodeId: 'analyst', ordinal: 1, name: 'plan' }],
  );
  // developer received the analyst's output under the declared `as` key.
  assert.deepEqual(rec.inputsByStep['developer'], { plan: { verdict: 'approved', from: 'analyst' } });
});

test('DD-DF4: a missing required input fails the run (revo.InputMissing) WITHOUT invoking the consumer', async () => {
  // iteration:3 can never be satisfied (analyst produces ordinal 1) → fail-loud wiring fault.
  const tmpl = template('df-missing')
    .specVersion('1.0')
    .entry('analyst')
    .domain('approved')
    .add(
      node.agent('analyst', 'role:analyst', 'developer', { resultSchema: 'schema:plan', produces: { name: 'plan' } }),
      node.agent('developer', 'role:developer', 'done', {
        resultSchema: 'schema:change',
        consumes: [{ node: 'analyst', as: 'plan', iteration: 3 }],
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  const { run, rec } = buildAdapter({ template: tmpl });
  const result = await run();
  assert.equal(result.status, 'failed', 'a missing required input fails the run');
  assert.ok(
    rec.events.some((e) => e.startsWith('step_failed:')),
    'a dedicated step_failed event is emitted for the missing input',
  );
  assert.equal(rec.inputsByStep['developer'], undefined, 'the consumer agent is never invoked');
});

test('DD-DF5: an optional missing input is omitted and the consumer still runs', async () => {
  const tmpl = template('df-opt')
    .specVersion('1.0')
    .entry('analyst')
    .domain('approved')
    .add(
      node.agent('analyst', 'role:analyst', 'developer', { resultSchema: 'schema:plan', produces: { name: 'plan' } }),
      node.agent('developer', 'role:developer', 'done', {
        resultSchema: 'schema:change',
        consumes: [{ node: 'analyst', as: 'missing', iteration: 9, optional: true }],
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  const { run } = buildAdapter({ template: tmpl });
  assert.equal((await run()).status, 'succeeded', 'optional missing input does not block');
});

test('DD-DF6: run_outputs ordinals increment across a rework loop (append-only history)', async () => {
  const tmpl = template('df-loop')
    .specVersion('1.0')
    .entry('a')
    .domain('approved', 'blocker')
    .scope('L', { cap: 2, parent: null })
    .add(
      node.agent('a', 'role:analyst', 'dev', { produces: { name: 'plan' } }),
      node.agent('dev', 'role:developer', 'router', { produces: { name: 'change' } }),
      node.choice('router', [on(allOf(verdictEq('blocker'), counterLt('L', 2)), 'rework'), otherwise('done')]),
      node.agent('rework', 'role:developer', 'router', { produces: { name: 'change' }, incrementCounters: ['L'] }),
      node.terminal('done', 'succeeded'),
    )
    .build();
  const { run, rec } = buildAdapter({ template: tmpl, verdicts: { dev: 'blocker', rework: 'blocker' } });
  await run();
  assert.deepEqual(
    rec.outputs.filter((o) => o.nodeId === 'rework').map((o) => o.ordinal),
    [1, 2],
    'each loop iteration appends a distinct-ordinal output',
  );
});

// ─── confirmMerge node (plan 0017 follow-up) ─────────────────────────────────

test('confirmMerge: merged → succeeded terminal, worktree released', async () => {
  const { run, rec } = buildAdapter({ template: confirmMergeFlow() }); // default fake → merged
  const r = await run();
  assert.equal(r.status, 'succeeded');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge ran once');
  assert.ok(rec.events.includes('merge_confirmed:confirmMerge'), 'emitted merge_confirmed');
  assert.ok(rec.events.includes('worktree_create:pipeline'));
  assert.ok(rec.events.includes('worktree_release:pipeline'), 'worktree released on merged/succeeded');
});

test('confirmMerge: not merged (block) → blocked terminal, worktree KEPT', async () => {
  const { run, rec } = buildAdapter({
    template: confirmMergeFlow(),
    confirmMerge: () => ({ needsHuman: true, lesson: 'PR not auto-mergeable (mergeStateStatus=BLOCKED)' }),
  });
  const r = await run();
  assert.equal(r.status, 'blocked');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge ran once');
  assert.ok(rec.events.includes('worktree_create:pipeline'));
  assert.ok(!rec.events.includes('worktree_release:pipeline'), 'worktree KEPT on blocked (rework / manual merge)');
});
