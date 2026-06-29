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
import { makeDataDrivenTask, resolveRunnerTransientRetryPolicy, type DataDrivenProgressCursor, type DataDrivenTaskDeps, type GateSummary, type RunnerTransientRetryPolicy } from './data-driven-task.workflow.js';
import { templateFromExecutionPolicy } from './data-driven-template.js';
import { featureDevelopment, featureDevelopmentPrReview, confirmMergeFlow, localChange } from '../pipeline-core/kit/fixtures.js';
import type { Template } from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { AppendEventInput } from '../run/append-event.js';
import type { RouteDecision, RouteRoleBinding } from './route-contract.js';
import type { Decision as GateDecision } from './await-human.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  RespondThreadsOutput,
  ProducedChangeArtifact,
} from '../runners/integrator.js';
import { template, node, on, otherwise, verdictEq, allOf, counterLt } from '../pipeline-core/kit/index.js';
import { RUNNER_IDLE_TIMEOUT_KIND, RUNNER_WALL_CLOCK_LIMIT_KIND } from '../worker/process-executor.js';
import type { IssueRef } from '../run/issue-ref.js';

const RUN_ID = 'run-dd-001';

function binding(roleId: string, resolvedRunnerId = 'script'): RouteRoleBinding {
  return { roleId, rowId: roleId, modelLevel: 'standard', runnerId: 'claude-code', resolvedRunnerId, runnerSource: 'playbook' };
}

/** A route binding the data-driven feature template's roleRefs/scriptRef resolve against. */
function makeRoute(options: { developerRunnerId?: string; integratorRunnerId?: string } = {}): RouteDecision {
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
      binding('developer', options.developerRunnerId ?? 'claude-code'),
      binding('reviewer'),
      binding('triager'),
      binding('integrator', options.integratorRunnerId ?? 'revo-integrator'), // real-integrator runner → script:integrator resolves here
      binding('watcher'),
    ],
    params: {},
  };
}

type Recorder = {
  gates: string[];
  gateSummaries: GateSummary[];
  completed: Array<{ verdict?: string }>;
  blocked: Array<{ reason?: string }>;
  /** Lessons carried on emitted `pipeline_blocked` events (the human-readable WHY). */
  blockedLessons: string[];
  failed: string[];
  integrateCalls: number;
  integratorInputs: IntegratorInput[];
  confirmMergeCalls: number;
  confirmMergeInputs: IntegratorInput[];
  pollPrCalls: number;
  respondCalls: number;
  /** The triage each respondThreads call consumed (asserts the 0016 script-consumes hydration). */
  respondTriage: unknown[];
  events: string[];
  eventRecords: AppendEventInput[];
  /** Persisted step outputs (0016 dataflow). */
  outputs: Array<{ nodeId: string; ordinal: number; name: string; payload: unknown; attemptId?: string }>;
  /** Captured change artifacts (issue #140 handoff contract). */
  capturedChanges: ProducedChangeArtifact[];
  /** issueRef values passed into worktree creation. */
  worktreeIssueRefs: Array<IssueRef | undefined>;
  /** Hydrated `inputs` the adapter passed to each step, keyed by stepKey (0016 consumes). */
  inputsByStep: Record<string, unknown>;
  runStepAttempts: Array<{ stepKey: string; attemptNo?: number; attemptId?: string }>;
  acceptedVerdictsByStep: Record<string, readonly string[] | undefined>;
  retrySleeps: number[];
  progress: DataDrivenProgressCursor[];
};

/**
 * Build the adapter from a per-node verdict script + a gate decider. `runStepFn` returns the scripted
 * top-level domain verdict for the node id; an absent entry returns `approved`.
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
  /** Exact per-node result override for invalid-result contract tests. */
  results?: Record<string, AttemptResult | AttemptResult[]>;
  route?: RouteDecision;
  retryPolicy?: RunnerTransientRetryPolicy;
  onSleep?: (ms: number) => void | Promise<void>;
  issueRef?: IssueRef;
}) {
  const rec: Recorder = {
    gates: [],
    gateSummaries: [],
    completed: [],
    blocked: [],
    blockedLessons: [],
    failed: [],
    integrateCalls: 0,
    integratorInputs: [],
    confirmMergeCalls: 0,
    confirmMergeInputs: [],
    pollPrCalls: 0,
    respondCalls: 0,
    respondTriage: [],
    events: [],
    eventRecords: [],
    outputs: [],
    capturedChanges: [],
    worktreeIssueRefs: [],
    inputsByStep: {},
    runStepAttempts: [],
    acceptedVerdictsByStep: {},
    retrySleeps: [],
    progress: [],
  };
  const visits = new Map<string, number>();

  const runStepFn = async (
    _runId: string,
    _role: string,
    stepKey: string,
    input: unknown,
    _resolvedRunnerId?: string,
    _executionProfile?: unknown,
    physicalAttempt?: { attemptNo: number; attemptId: string },
    acceptedVerdicts?: readonly string[],
  ): Promise<AttemptResult> => {
    rec.acceptedVerdictsByStep[stepKey] = acceptedVerdicts;
    // The adapter ordinal-suffixes the stepKey on loop re-entries (0016 §4.1: `nodeId#2`); the verdict
    // script + visit count are keyed by the NODE (a verdict is a property of the role, not the iteration).
    const nodeId = stepKey.includes('#') ? stepKey.slice(0, stepKey.indexOf('#')) : stepKey;
    const n = visits.get(nodeId) ?? 0;
    visits.set(nodeId, n + 1);
    rec.runStepAttempts.push({
      stepKey,
      attemptNo: physicalAttempt?.attemptNo,
      attemptId: physicalAttempt?.attemptId,
    });
    // Capture hydrated consumes (0016) so a test can assert an upstream output reached this step.
    if (input !== null && typeof input === 'object' && 'inputs' in (input as Record<string, unknown>)) {
      rec.inputsByStep[stepKey] = (input as Record<string, unknown>).inputs;
    }
    if (opts.needsHumanNodes?.has(nodeId)) {
      return { output: { from: nodeId }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'parked' };
    }
    const scripted = opts.results?.[nodeId];
    const exact = Array.isArray(scripted) ? scripted[Math.min(n, scripted.length - 1)] : scripted;
    if (exact) return exact;
    const entry = opts.verdicts?.[nodeId];
    const verdict = Array.isArray(entry) ? (entry[Math.min(n, entry.length - 1)] ?? 'approved') : (entry ?? 'approved');
    return { output: { from: nodeId }, verdict, nextSteps: [], costs: [] };
  };

  const deps: DataDrivenTaskDeps = {
    appendEvent: async (e) => {
      rec.eventRecords.push(e);
      rec.events.push(`${e.type}:${e.stepKey}`);
      if (e.type === 'pipeline_blocked' && e.payload && typeof e.payload === 'object') {
        const lesson = (e.payload as { lesson?: unknown }).lesson;
        if (typeof lesson === 'string') rec.blockedLessons.push(lesson);
      }
    },
    appendRunOutput: async (o) => { rec.outputs.push({ nodeId: o.nodeId, ordinal: o.ordinal, name: o.name, payload: o.payload, attemptId: o.attemptId }); },
    setProgress: async (_runId, cursor) => { rec.progress.push(cursor); },
    sleep: async (ms) => {
      rec.retrySleeps.push(ms);
      await opts.onSleep?.(ms);
    },
    awaitHuman: async (_runId, topic, _gateKey, _title, summary): Promise<GateDecision> => {
      rec.gates.push(topic);
      rec.gateSummaries.push(summary as GateSummary);
      return (opts.gate ?? (() => ({ decision: 'approve' })))(topic);
    },
    completeRun: async (_runId, o) => { rec.completed.push({ verdict: o?.verdict }); return null; },
    failRun: async (_runId, reason) => { rec.failed.push(reason); return null; },
    blockRun: async (_runId, o) => { rec.blocked.push({ reason: o?.reason }); return null; },
    loadRunTaskContext: async () => ({ taskId: 'task-1', title: 'T', base: 'master', repoRef: '', issueRef: opts.issueRef }),
    integrateFn: async (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
      rec.integrateCalls++;
      rec.integratorInputs.push(input);
      if (opts.integrate) return opts.integrate(input);
      return { prUrl: `https://example/pr/${input.taskId}`, branch: 'feat/x', prNumber: 1 };
    },
    runStub: (input: IntegratorInput): IntegratorOutput => {
      rec.integrateCalls++;
      rec.integratorInputs.push(input);
      return { prUrl: 'stub://pr/placeholder', branch: `feat/${input.taskId}-stub`, prNumber: 0 };
    },
    // The test route binds the integrator to revo-integrator (a live runner), so preflight runs. By
    // default it passes (these tests exercise the graph, not preflight); a test can override it.
    preflightFn: async () => (opts.preflight ? opts.preflight() : { ok: true }),
    // Per-run worktree lifecycle (plan 0017) — fakes here record create/release ordering via events;
    // the live runner binding means both fire (create after preflight, release in the terminal finally).
    createWorktreeFn: async (_runId, _taskId, _title, _base, issueRef) => {
      rec.events.push('worktree_create:pipeline');
      rec.worktreeIssueRefs.push(issueRef);
      return { worktreePath: '/fake/worktree' };
    },
    releaseWorktreeFn: async () => { rec.events.push('worktree_release:pipeline'); },
    // confirmMerge (plan 0017 follow-up): default fake reports merged; a test can override via opts.confirmMerge.
    confirmMergeFn: async (input: IntegratorInput) => {
      rec.confirmMergeCalls++;
      rec.confirmMergeInputs.push(input);
      if (opts.confirmMerge) return opts.confirmMerge(input);
      return { merged: true as const, prNumber: 1, prUrl: `https://example/pr/${input.taskId}/merged` };
    },
    runConfirmStub: (input: IntegratorInput) => ({ merged: true as const, prNumber: 0, prUrl: `stub://pr/${input.taskId}/merged` }),
    // pollPr (plan 0018): default fake reports a CLEAN PR so the loop converges to the merge gate.
    pollPrFn: async (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
      rec.pollPrCalls++;
      if (opts.pollPr) return opts.pollPr(input);
      return {
        prNumber: 1,
        headSha: `sha-${rec.pollPrCalls}`,
        evidence: [`pollPr call ${rec.pollPrCalls}: clean`],
        verdict: 'clean' as const,
        ciFailures: [],
        reviewThreads: [],
      };
    },
    runPollStub: (_input: IntegratorInput): PrFeedback => ({
      prNumber: 0,
      headSha: 'stub',
      evidence: ['stub pollPr readiness: clean'],
      verdict: 'clean',
      ciFailures: [],
      reviewThreads: [],
    }),
    // respondThreads (plan 0018): capture the consumed triage; default reports nothing to reply/resolve.
    respondThreadsFn: async (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
      rec.respondCalls++;
      rec.respondTriage.push(input.triage);
      if (opts.respondThreads) return opts.respondThreads(input);
      return { replied: 0, resolved: 0 };
    },
    runRespondStub: (_input: IntegratorInput): RespondThreadsOutput => ({ replied: 0, resolved: 0 }),
    captureChangeFn: async (input) => {
      const change: ProducedChangeArtifact = {
        branch: `feat/${input.taskId}`,
        headSha: `sha-${input.nodeId}-${input.attemptId}`,
        worktreePath: '/fake/worktree',
        ...(input.issueRef ? { issueRef: input.issueRef } : {}),
        ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
      };
      rec.capturedChanges.push(change);
      return change;
    },
  };

  const fn = makeDataDrivenTask(runStepFn, deps);
  const template = opts.template ?? featureDevelopment();
  return {
    run: () => fn(RUN_ID, {
      route: opts.route ?? makeRoute(),
      template,
      runnerRetryPolicy: opts.retryPolicy ?? resolveRunnerTransientRetryPolicy(),
    }),
    rec,
  };
}

function singleDeveloperTemplate(pipelineId: string): Template {
  return template(pipelineId)
    .specVersion('1.0')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'done', {
        resultSchema: 'schema:change',
        produces: { name: 'change' },
      }),
      node.terminal('done', 'succeeded'),
    )
    .build();
}

function runnerFailedResult(reason: string, extraOutput: Record<string, unknown> = {}): AttemptResult {
  return {
    output: {
      verdict: 'BLOCKER',
      error: 'runner_failed',
      role: 'developer',
      stepKey: 'developer',
      reason,
      ...extraOutput,
    },
    verdict: 'BLOCKER',
    nextSteps: [],
    costs: [],
    needsHuman: true,
    lesson: reason,
  };
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test('DD1: happy path — analyst→plan→developer→review→integrate→pollPr(clean)→mergeReadiness(clean)→merge→confirmMerge → succeeded', async () => {
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
  assert.equal(rec.pollPrCalls, 2, 'pollPr observed the PR, then mergeReadiness rechecked it before the merge gate');
  const mergeSummary = rec.gateSummaries.find((summary) => summary.nodeId === 'mergeGate');
  assert.equal(mergeSummary?.gatedArtifact?.nodeId, 'mergeReadiness', 'merge gate surfaces the fresh readiness artifact');
  assert.deepEqual(
    (mergeSummary?.gatedArtifact?.payload as { headSha?: string; evidence?: string[] } | undefined),
    {
      prNumber: 1,
      headSha: 'sha-2',
      evidence: ['pollPr call 2: clean'],
      verdict: 'clean',
      ciFailures: [],
      reviewThreads: [],
    },
    'merge gate payload carries the fresh head sha and readiness evidence',
  );
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge ran once at the success terminal');
  assert.deepEqual(
    rec.confirmMergeInputs[0]?.mergeReadiness,
    { headSha: 'sha-2' },
    'confirmMerge consumes the fresh mergeReadiness head sha for the GitHub merge guard',
  );
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
});

test('DD1b: adapter publishes graph progress cursors through its sealed dep', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
  });

  await run();

  assert.ok(rec.progress.length > 0);
  assert.deepEqual(rec.progress[0]?.activeNodeIds, ['analyst']);
  assert.equal(rec.progress.at(-1)?.status, 'succeeded');
  assert.deepEqual(rec.progress.at(-1)?.activeNodeIds, ['mergedEnd']);
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

test('DD4: pollPr ci_changes → ciRework → re-integrate → pollPr(clean) → mergeReadiness(clean) → merge → succeeded', async () => {
  // First poll reports a CI failure (ci_changes) → ciRework (developer) fixes it → integrator re-pushes →
  // second poll is clean → mergeReadiness is clean → merge gate → confirmMerge → succeeded. Proves the
  // bounded CI rework loop.
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      polls++;
      return polls === 1
        ? { prNumber: 1, headSha: 's1', evidence: ['poll 1: build failed'], verdict: 'ci_changes' as const, ciFailures: [{ name: 'build', conclusion: 'FAILURE' }], reviewThreads: [] }
        : { prNumber: 1, headSha: `s${polls}`, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.equal(rec.pollPrCalls, 3, 'polled for CI failure, then clean, then fresh merge readiness');
  assert.equal(rec.integrateCalls, 2, 'integrator ran for the initial PR + the CI re-push');
  // ciRework consumed the prFeedback (0016) — its hydrated input carries the failing-check feedback.
  const ciFeedback = (rec.inputsByStep['ciRework'] as { feedback?: { verdict?: string } } | undefined)?.feedback;
  assert.equal(ciFeedback?.verdict, 'ci_changes', 'ciRework consumed pollPr prFeedback');
  assert.match(
    rec.integratorInputs[1]?.change?.headSha ?? '',
    /^sha-ciRework-/,
    'the second integrator call consumes the CI rework produced head',
  );
});

test('DD4-issue-143: mergeReadiness review_changes routes to triage with fresh feedback before any merge gate', async () => {
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', triage: 'wontfix' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      polls++;
      if (polls === 1) {
        return { prNumber: 1, headSha: 'initial-clean', evidence: ['initial poll clean'], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
      }
      if (polls === 2) {
        return {
          prNumber: 1,
          headSha: 'fresh-review',
          evidence: ['fresh pre-gate poll found review thread T9'],
          verdict: 'review_changes' as const,
          ciFailures: [],
          reviewThreads: [{ threadId: 'T9', body: 'fix before merge' }],
        };
      }
      return { prNumber: 1, headSha: `post-triage-${polls}`, evidence: [`post-triage poll ${polls} clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(rec.respondCalls, 1, 'fresh review feedback routed through triage/respondThreads before merge');
  const triageInputs = rec.inputsByStep.triage as { feedback?: { headSha?: string }; mergeFeedback?: { headSha?: string; evidence?: string[] } };
  assert.equal(triageInputs.feedback?.headSha, 'initial-clean', 'the original poll feedback remains available');
  assert.equal(triageInputs.mergeFeedback?.headSha, 'fresh-review', 'triage receives the fresh pre-gate feedback');
  assert.deepEqual(triageInputs.mergeFeedback?.evidence, ['fresh pre-gate poll found review thread T9']);
  const mergeSummary = rec.gateSummaries.find((summary) => summary.nodeId === 'mergeGate');
  assert.equal(
    (mergeSummary?.gatedArtifact?.payload as { headSha?: string } | undefined)?.headSha,
    'post-triage-4',
    'merge gate opens only after a later clean mergeReadiness recheck',
  );
});

test('DD4-issue-143b: mergeReadiness ci_changes routes to ciRework with fresh feedback before merge', async () => {
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      polls++;
      if (polls === 1) {
        return { prNumber: 1, headSha: 'initial-clean', evidence: ['initial poll clean'], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
      }
      if (polls === 2) {
        return {
          prNumber: 1,
          headSha: 'fresh-ci',
          evidence: ['fresh pre-gate poll found required check failure'],
          verdict: 'ci_changes' as const,
          ciFailures: [{ name: 'Verify', conclusion: 'FAILURE' }],
          reviewThreads: [],
        };
      }
      return { prNumber: 1, headSha: `post-ci-${polls}`, evidence: [`post-ci poll ${polls} clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(rec.integrateCalls, 2, 'fresh CI feedback routes through ciRework and re-integrates before merge');
  const ciInputs = rec.inputsByStep.ciRework as { feedback?: { headSha?: string }; mergeFeedback?: { headSha?: string; ciFailures?: unknown[]; evidence?: string[] } };
  assert.equal(ciInputs.feedback?.headSha, 'initial-clean', 'the original poll feedback remains available');
  assert.equal(ciInputs.mergeFeedback?.headSha, 'fresh-ci', 'ciRework receives the fresh pre-gate feedback');
  assert.deepEqual(ciInputs.mergeFeedback?.ciFailures, [{ name: 'Verify', conclusion: 'FAILURE' }]);
  assert.deepEqual(ciInputs.mergeFeedback?.evidence, ['fresh pre-gate poll found required check failure']);
});

/**
 * #141 — make the `feature-development-pr-review` fixture EVIDENCE-DRIVEN on a merge-gate reject, mirroring
 * the data-only JSON edit (default + e2e fixture catalogs): the merge gate gains a `recheck` outcome that
 * routes a REJECT (via gateVerdict's reject→last-outcome rule) to a dedicated `mergeRecheck` re-poll, whose
 * router routes on the FRESH verdict — clean→blockedEnd (explicit abort), review_changes→triage, ci_changes
 * (<ciLoop)→ciRework. No runtime code changes; the routing lives entirely in the template (§8).
 */
function featureDevelopmentPrReviewWithMergeRecheck(): Template {
  const t = featureDevelopmentPrReview();
  if (!t.verdicts.domain.includes('recheck')) t.verdicts.domain = [...t.verdicts.domain, 'recheck'];
  const mergeGate = t.nodes['mergeGate'];
  assert.equal(mergeGate?.kind, 'humanGate', 'fixture mergeGate is a humanGate');
  if (mergeGate.kind === 'humanGate') {
    mergeGate.outcomes = ['approved', 'recheck'];
    mergeGate.branches = [
      on(verdictEq('approved'), 'confirmMerge'),
      on(verdictEq('recheck'), 'mergeRecheck'),
      otherwise('blockedEnd'),
    ];
  }
  t.nodes['mergeRecheck'] = node.script('mergeRecheck', 'script:pollPr', 'mergeRecheckRouter', {
    resultSchema: 'schema:prFeedback',
    onFailure: 'route',
    produces: { name: 'prFeedback' },
    catch: [
      { onError: 'revo.ScriptBlocked', goto: 'blockedEnd' },
      { onError: 'revo.ScriptFailed', goto: 'failedEnd' },
    ],
  });
  t.nodes['mergeRecheckRouter'] = node.choice('mergeRecheckRouter', [
    on(verdictEq('clean'), 'blockedEnd'),
    on(verdictEq('review_changes'), 'triage'),
    on(allOf(verdictEq('ci_changes'), counterLt('ciLoop', 3)), 'ciRework'),
    otherwise('blockedEnd'),
  ]);
  // Mirror the JSON catalogs: the recovery nodes also consume the FRESH mergeRecheck feedback (optional +
  // staleOk, since mergeRecheck only runs on the reject path) so a reject-routed triage/ciRework acts on the
  // re-poll evidence, not the stale pre-gate readiness.
  for (const nodeId of ['triage', 'ciRework']) {
    const recovery = t.nodes[nodeId];
    if (recovery.kind === 'agent') {
      recovery.consumes = [
        ...(recovery.consumes ?? []),
        { node: 'mergeRecheck', as: 'recheckFeedback', optional: true, staleOk: true },
      ];
    }
  }
  return t;
}

test('DD-issue-141 (abort): merge reject + a still-clean re-poll routes to blockedEnd (explicit abort, NOT a silent terminal)', async () => {
  // The merge gate opens after pollPr(clean)→mergeReadiness(clean). A human REJECT now maps to the `recheck`
  // outcome → mergeRecheck re-polls; the gh state is unchanged (clean) → mergeRecheckRouter clean→blockedEnd.
  // "Nothing changed since the gate opened ⇒ the reject was a genuine abort." Proves the reject re-checks
  // evidence instead of always terminal-blocking, and that a clean re-poll still settles `blocked`.
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReviewWithMergeRecheck(),
    verdicts: { codeReview: 'approved' },
    gate: (topic) => (topic === 'merge' ? { decision: 'reject' } : { decision: 'approve' }),
    // every pollPr (pollPr, mergeReadiness, mergeRecheck) is clean — the default fake already returns clean.
  });

  const result = await run();

  assert.equal(result.status, 'blocked', 'a still-clean re-poll on merge reject is an explicit abort → blocked');
  assert.equal(rec.completed.length, 0, 'an aborted merge does not complete the run');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge never ran (the reject aborted instead of merging)');
  assert.equal(rec.pollPrCalls, 3, 'pollPr → mergeReadiness → mergeRecheck (the reject re-polled fresh readiness)');
  assert.deepEqual(rec.gates, ['plan', 'merge'], 'the merge gate opened once, then the reject re-polled rather than re-gating');
});

test('DD-issue-141 (reroute): merge reject + a review_changes re-poll reroutes to triage (recoverable), NOT blocked', async () => {
  // The merge gate opens after pollPr(clean)→mergeReadiness(clean). A human REJECT re-polls; this time the
  // re-poll finds a fresh review thread (review_changes) → mergeRecheckRouter review_changes→triage. The run
  // RECOVERS through the existing review loop (triage wontfix→respondThreads→clean→merge) and is NOT blocked.
  let polls = 0;
  let mergeSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReviewWithMergeRecheck(),
    verdicts: { codeReview: 'approved', triage: 'wontfix' },
    gate: (topic) => {
      if (topic !== 'merge') return { decision: 'approve' };
      mergeSeen++;
      // reject the FIRST merge gate (drives the re-poll reroute); approve the SECOND (after recovery).
      return mergeSeen === 1 ? { decision: 'reject' } : { decision: 'approve' };
    },
    pollPr: () => {
      polls++;
      // poll 1 = pollPr, poll 2 = mergeReadiness (both clean → reach the merge gate);
      // poll 3 = mergeRecheck after the reject → review_changes (reroute to triage); then clean to recover.
      if (polls === 3) {
        return {
          prNumber: 1,
          headSha: 'recheck-review',
          evidence: ['merge-reject re-poll found a fresh review thread T141'],
          verdict: 'review_changes' as const,
          ciFailures: [],
          reviewThreads: [{ threadId: 'T141', body: 'address before merge' }],
        };
      }
      return { prNumber: 1, headSha: `poll-${polls}`, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.notEqual(result.status, 'blocked', 'a review_changes re-poll is recoverable — the reject must NOT block');
  assert.equal(result.status, 'succeeded', 'the run recovers through triage/respondThreads, then a clean re-poll merges');
  // The reject's re-poll (poll 3) returned review_changes → mergeRecheckRouter routed it to triage, which the
  // analyst handled (wontfix) → respondThreads. respondThreads only runs on the triage recovery path, so a
  // single call proves the reject rerouted to triage rather than terminal-blocking.
  assert.equal(rec.respondCalls, 1, 'the rerouted review thread went through triage/respondThreads (the recovery path)');
  // The evidence handoff (not just the route): the reject-routed triage was hydrated with the FRESH
  // mergeRecheck feedback (poll 3, headSha `recheck-review`) via its new `recheckFeedback` consume — so the
  // analyst triages the re-poll evidence, not the stale pre-gate readiness (poll 2).
  const triageInputs = rec.inputsByStep['triage'] as { recheckFeedback?: { headSha?: string; reviewThreads?: Array<{ threadId?: string }> } } | undefined;
  assert.equal(triageInputs?.recheckFeedback?.headSha, 'recheck-review', 'triage received the fresh merge-recheck feedback');
  assert.deepEqual(
    triageInputs?.recheckFeedback?.reviewThreads,
    [{ threadId: 'T141', body: 'address before merge' }],
    'the fresh review thread the re-poll surfaced reached triage',
  );
  assert.equal(rec.blocked.length, 0, 'the run never hit blockRun — the reject was rerouted, not aborted');
  assert.equal(mergeSeen, 2, 'the merge gate opened twice (reject→reroute→recover→re-gate→approve)');
});

test('DD4-issue-140: code-review changes_requested rework hands the latest produced change to integrator', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: ['changes_requested', 'approved'] },
    gate: () => ({ decision: 'approve' }),
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(rec.integrateCalls, 1);
  assert.match(
    rec.integratorInputs[0]?.change?.headSha ?? '',
    /^sha-reworkDeveloper-/,
    'integrator must receive the reworkDeveloper head, not the initial developer head',
  );
  assert.ok(
    (rec.inputsByStep['codeReview'] as { developerChange?: unknown } | undefined)?.developerChange,
    'the first reviewer pass receives the initial developer change artifact',
  );
  assert.ok(
    (rec.inputsByStep['codeReview#2'] as { reworkChange?: unknown } | undefined)?.reworkChange,
    'the second reviewer pass receives the rework change artifact',
  );
});

test('issueRef: run context reaches worktree creation, produced change, and integrator input', async () => {
  const issueRef: IssueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    issueRef,
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.worktreeIssueRefs, [issueRef]);
  assert.deepEqual(rec.capturedChanges[0]?.issueRef, issueRef);
  assert.deepEqual(rec.integratorInputs[0]?.issueRef, issueRef);
  assert.deepEqual(rec.integratorInputs[0]?.change?.issueRef, issueRef);
});

test('issueRef: run context overrides mismatched produced change issueRef before integrator handoff', async () => {
  const runIssueRef: IssueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const staleIssueRef: IssueRef = {
    repo: 'revisium/orchestrator',
    number: 148,
    url: 'https://github.com/revisium/orchestrator/issues/148',
  };
  const stubChange: ProducedChangeArtifact = {
    branch: 'feat/stub-produced',
    headSha: 'stub-produced-sha',
    worktreePath: '/stub/worktree',
    issueRef: staleIssueRef,
  };
  const tmpl = template('run-issue-ref-authoritative')
    .specVersion('1.0')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'integrator', {
        resultSchema: 'schema:change',
        produces: { name: 'change' },
      }),
      node.script('integrator', 'script:integrator', 'done', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        consumes: [{ node: 'developer', as: 'developerChange' }],
        catch: [{ onError: 'revo.ScriptFailed', goto: 'failed' }],
      }),
      node.terminal('done', 'succeeded'),
      node.terminal('failed', 'failed'),
    )
    .build();
  const { run, rec } = buildAdapter({
    template: tmpl,
    route: makeRoute({ developerRunnerId: 'script', integratorRunnerId: 'script' }),
    issueRef: runIssueRef,
    results: {
      developer: {
        output: { from: 'developer', change: stubChange },
        verdict: 'approved',
        nextSteps: [],
        costs: [],
      },
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.integratorInputs[0]?.issueRef, runIssueRef);
  assert.deepEqual(rec.integratorInputs[0]?.change, { ...stubChange, issueRef: runIssueRef });
});

test('issueRef: no-issue run strips produced change issueRef before integrator handoff', async () => {
  const artifactIssueRef: IssueRef = {
    repo: 'revisium/orchestrator',
    number: 147,
    url: 'https://github.com/revisium/orchestrator/issues/147',
  };
  const stubChange: ProducedChangeArtifact = {
    branch: 'feat/stub-produced',
    headSha: 'stub-produced-sha',
    worktreePath: '/stub/worktree',
    issueRef: artifactIssueRef,
  };
  const tmpl = template('no-issue-run-ignores-artifact-issue-ref')
    .specVersion('1.0')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'integrator', {
        resultSchema: 'schema:change',
        produces: { name: 'change' },
      }),
      node.script('integrator', 'script:integrator', 'done', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        consumes: [{ node: 'developer', as: 'developerChange' }],
        catch: [{ onError: 'revo.ScriptFailed', goto: 'failed' }],
      }),
      node.terminal('done', 'succeeded'),
      node.terminal('failed', 'failed'),
    )
    .build();
  const { run, rec } = buildAdapter({
    template: tmpl,
    route: makeRoute({ developerRunnerId: 'script', integratorRunnerId: 'script' }),
    results: {
      developer: {
        output: { from: 'developer', change: stubChange },
        verdict: 'approved',
        nextSteps: [],
        costs: [],
      },
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(rec.integratorInputs[0]?.issueRef, undefined);
  assert.deepEqual(rec.integratorInputs[0]?.change, {
    branch: 'feat/stub-produced',
    headSha: 'stub-produced-sha',
    worktreePath: '/stub/worktree',
  });
});

test('DD4a-issue-140: non-live produced change metadata reaches the integrator without worktree capture', async () => {
  const stubChange: ProducedChangeArtifact = {
    branch: 'feat/stub-produced',
    headSha: 'stub-produced-sha',
    worktreePath: '/stub/worktree',
  };
  const tmpl = template('stub-change-preserved')
    .specVersion('1.0')
    .entry('developer')
    .domain('approved')
    .add(
      node.agent('developer', 'role:developer', 'integrator', {
        resultSchema: 'schema:change',
        produces: { name: 'change' },
      }),
      node.script('integrator', 'script:integrator', 'done', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        consumes: [{ node: 'developer', as: 'developerChange' }],
        catch: [{ onError: 'revo.ScriptFailed', goto: 'failed' }],
      }),
      node.terminal('done', 'succeeded'),
      node.terminal('failed', 'failed'),
    )
    .build();
  const { run, rec } = buildAdapter({
    template: tmpl,
    route: makeRoute({ developerRunnerId: 'script', integratorRunnerId: 'script' }),
    results: {
      developer: {
        output: { from: 'developer', change: stubChange },
        verdict: 'approved',
        nextSteps: [],
        costs: [],
      },
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.integratorInputs[0]?.change, stubChange);
  assert.deepEqual(rec.capturedChanges, [], 'script/stub change producers must not invoke worktree capture');
  assert.ok(!rec.events.includes('worktree_create:pipeline'), 'non-live routes do not create a run worktree');
});

test('DD4b: pollPr ci_changes forever → cap → blocked terminal (ciLoop is DATA)', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => ({ prNumber: 1, headSha: 's', evidence: ['build failed'], verdict: 'ci_changes' as const, ciFailures: [{ name: 'build', conclusion: 'FAILURE' }], reviewThreads: [] }),
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'the CI loop blocks at its cap, not the agent');
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.confirmMergeCalls, 0, 'never reached the merge gate');
});

test('DD4c: pollPr review_changes → triage(fix) → reviewRework → integrate → respondThreads → pollPr(clean) → mergeReadiness(clean) → merge', async () => {
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
        ? { prNumber: 1, headSha: 's1', evidence: ['poll 1: review thread T1'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'fix this' }] }
        : { prNumber: 1, headSha: `s${polls}`, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.equal(rec.respondCalls, 1, 'respondThreads ran once (reply + resolve the fixed thread)');
  assert.equal(rec.integrateCalls, 2, 'integrator ran for the initial PR + the review re-push (reviewIntegrator)');
  assert.match(
    rec.integratorInputs[1]?.change?.headSha ?? '',
    /^sha-reviewRework-/,
    'reviewIntegrator consumes the reviewRework produced head',
  );
  // respondThreads consumed the triage produced by the analyst (0016 script-consumes hydration).
  assert.ok(rec.respondTriage.length === 1 && rec.respondTriage[0] !== undefined, 'respondThreads consumed the triage');
});

test('DD4d: pollPr review_changes → triage(question) → questionGate(approve) → triage(wontfix) → respondThreads → pollPr(clean) → mergeReadiness(clean)', async () => {
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
          ? { prNumber: 1, headSha: 's1', evidence: ['poll 1: review thread T1'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'why?' }] }
          : { prNumber: 1, headSha: `s${polls}`, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
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

test('DD5: a DELIBERATE agent needsHuman → blocked terminal + pipeline_blocked lesson, NOT a ResultInvalid abort', async () => {
  // A self-reported needsHuman (the result-envelope contract) is a recoverable human-block, not a wiring
  // fault. It must surface as `blocked` with the agent's lesson — never abort the run (regression guard:
  // the old engine turned this into revo.ResultInvalid → onFailure:'abort' → a silently failed run).
  const { run, rec } = buildAdapter({
    needsHumanNodes: new Set(['developer']), // developer self-reports needsHuman with lesson 'parked'
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'a needsHuman agent BLOCKS the run (does NOT fail/abort)');
  assert.equal(rec.blocked.length, 1, 'blockRun called for the blocked terminal');
  assert.equal(rec.failed.length, 0, 'failRun NOT called — needsHuman is a block, not a failure');
  assert.equal(rec.completed.length, 0);
  const block = rec.blocked[0];
  assert.equal(block?.reason, 'agent-needs-human', 'the block reason distinguishes a deliberate agent block');
  assert.ok(
    rec.events.includes('pipeline_blocked:pipeline'),
    'the blocking lesson is surfaced as pipeline_blocked (visible to the human)',
  );
  // The agent's own lesson rides the pipeline_blocked payload (asserted via the recorded lesson below).
  assert.ok(rec.blockedLessons.some((l) => l.includes('parked')), 'the agent lesson is carried on the block');
});

test('DD5-transient: a TRANSIENT runner_failed (crash/timeout/429) → blocked with a transient reason, NOT abort', async () => {
  // runStep (pipeline.service.ts) wraps a runner-process crash as a SYNTHETIC blocking attempt:
  // output={ verdict:'BLOCKER', error:'runner_failed', reason }, needsHuman:true. This is fully
  // recoverable; turning it into an abort permanently killed real runs (dogfooding, 4x). It must block
  // (visible, lesson-bearing) with a DISTINCT reason so the human sees it is transient, not a decision.
  const { run, rec } = buildAdapter({
    results: {
      developer: {
        output: { verdict: 'BLOCKER', error: 'runner_failed', role: 'developer', stepKey: 'developer', reason: 'runner process exited 1 (timeout)' },
        verdict: 'BLOCKER',
        nextSteps: [],
        costs: [],
        needsHuman: true,
        lesson: 'runner process exited 1 (timeout)',
      },
    },
  });
  const result = await run();
  assert.equal(result.status, 'blocked', 'a transient runner failure BLOCKS the run (does NOT abort)');
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.failed.length, 0, 'failRun NOT called — a transient failure is recoverable, not fatal');
  assert.equal(rec.blocked[0]?.reason, 'runner-transient-failure:timeout', 'the block reason marks it transient + names the kind');
  assert.ok(
    rec.blockedLessons.some((l) => l.includes('runner-transient-failure') && l.includes('timeout')),
    'the transient lesson names the recoverable runner reason',
  );
  assert.deepEqual(
    rec.runStepAttempts.filter((a) => a.stepKey === 'developer').map((a) => a.attemptNo),
    [1, 2],
    'default retry policy makes two physical attempts',
  );
  assert.ok(rec.events.includes('runner_retry_scheduled:developer'), 'retry scheduling is durable evidence');
  assert.ok(rec.events.includes('runner_retry_exhausted:developer'), 'retry exhaustion is durable evidence');
  const blocked = rec.eventRecords.find((e) => e.type === 'pipeline_blocked')?.payload as Record<string, unknown>;
  assert.equal(blocked.attemptsExhausted, true);
  assert.equal(blocked.attemptsMade, 2);
  assert.equal(blocked.maxAttempts, 2);
  assert.equal(blocked.lastAttemptId, rec.runStepAttempts.find((a) => a.attemptNo === 2)?.attemptId);
});

test('DD5-retry: retryable transient runner failure retries once and stores output against the winning attempt', async () => {
  const tmpl = singleDeveloperTemplate('retry-success');
  const { run, rec } = buildAdapter({
    template: tmpl,
    results: {
      developer: [
        {
          output: { verdict: 'BLOCKER', error: 'runner_failed', role: 'developer', stepKey: 'developer', reason: 'runner process timed out' },
          verdict: 'BLOCKER',
          nextSteps: [],
          costs: [],
          needsHuman: true,
          lesson: 'runner process timed out',
        },
        {
          output: { from: 'developer', ok: true },
          verdict: 'approved',
          nextSteps: [],
          costs: [],
          needsHuman: false,
        },
      ],
    },
  });

  const result = await run();
  const attempts = rec.runStepAttempts.filter((a) => a.stepKey === 'developer');

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(attempts.map((a) => a.attemptNo), [1, 2]);
  assert.notEqual(attempts[0]?.attemptId, attempts[1]?.attemptId, 'physical attempt ids differ');
  assert.deepEqual(rec.retrySleeps, [2_000], 'default backoff uses the DBOS sleep seam');
  assert.ok(rec.events.includes('runner_retry_scheduled:developer'));
  assert.equal(rec.events.includes('runner_retry_exhausted:developer'), false);
  assert.equal(rec.outputs[0]?.attemptId, attempts[1]?.attemptId, 'run_outputs points at the winner');
  assert.equal(rec.blocked.length, 0);
});

test('DD5-retry-policy-pin: changed env during recovery/between attempts does not change pinned policy', async () => {
  const oldMaxAttempts = process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'];
  const oldBackoff = process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'];
  const pinnedPolicy = resolveRunnerTransientRetryPolicy({
    REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS: '2',
    REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS: '1',
  } as NodeJS.ProcessEnv);
  let changedBetweenAttempts = false;
  try {
    process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'] = '1';
    process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'] = '0';
    const { run, rec } = buildAdapter({
      template: singleDeveloperTemplate('retry-policy-pin'),
      retryPolicy: pinnedPolicy,
      onSleep: () => {
        process.env['REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS'] = '1';
        process.env['REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS'] = '0';
        changedBetweenAttempts = true;
      },
      results: {
        developer: [
          runnerFailedResult('runner process timed out'),
          {
            output: { from: 'developer', ok: true },
            verdict: 'approved',
            nextSteps: [],
            costs: [],
            needsHuman: false,
          },
        ],
      },
    });

    const result = await run();

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(
      rec.runStepAttempts.filter((a) => a.stepKey === 'developer').map((a) => a.attemptNo),
      [1, 2],
      'the persisted workflow input keeps maxAttempts=2 even when process env now disables retry',
    );
    assert.deepEqual(rec.retrySleeps, [1], 'the persisted workflow input keeps the original backoff');
    assert.equal(changedBetweenAttempts, true, 'the environment changed after the first failed attempt');
  } finally {
    restoreEnvVar('REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS', oldMaxAttempts);
    restoreEnvVar('REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS', oldBackoff);
  }
});

test('DD5-no-retry: retryableCandidate:false does not schedule another attempt', async () => {
  const { run, rec } = buildAdapter({
    results: {
      developer: {
        output: {
          verdict: 'BLOCKER',
          error: 'runner_failed',
          role: 'developer',
          stepKey: 'developer',
          reason: 'runner process timed out but marked deterministic',
          retryableCandidate: false,
        },
        verdict: 'BLOCKER',
        nextSteps: [],
        costs: [],
        needsHuman: true,
        lesson: 'runner process timed out but marked deterministic',
      },
    },
  });

  const result = await run();
  const blocked = rec.eventRecords.find((e) => e.type === 'pipeline_blocked')?.payload as Record<string, unknown>;

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.runStepAttempts.filter((a) => a.stepKey === 'developer').map((a) => a.attemptNo), [1]);
  assert.equal(rec.events.includes('runner_retry_scheduled:developer'), false);
  assert.equal(rec.events.includes('runner_retry_exhausted:developer'), false);
  assert.equal(blocked.attemptsExhausted, false);
  assert.equal(blocked.attemptsMade, 1);
});

test('DD5-no-retry: quota, overage, auth, config, and contract runner failures are deterministic', async (t) => {
  const cases = [
    { name: 'quota', reason: 'provider quota exhausted' },
    { name: 'overage', reason: 'billing overage reached' },
    { name: 'auth', reason: 'auth required for runner account' },
    { name: 'config', reason: 'config gap: missing runner account' },
    { name: 'contract', reason: 'malformed runner contract envelope' },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const { run, rec } = buildAdapter({
        template: singleDeveloperTemplate(`no-retry-${c.name}`),
        results: { developer: runnerFailedResult(c.reason) },
      });

      const result = await run();
      const blocked = rec.eventRecords.find((e) => e.type === 'pipeline_blocked')?.payload as Record<string, unknown>;

      assert.equal(result.status, 'blocked');
      assert.deepEqual(
        rec.runStepAttempts.filter((a) => a.stepKey === 'developer').map((a) => a.attemptNo),
        [1],
      );
      assert.equal(rec.events.includes('runner_retry_scheduled:developer'), false);
      assert.equal(rec.events.includes('runner_retry_exhausted:developer'), false);
      assert.equal(blocked.attemptsExhausted, false);
      assert.equal(blocked.transientKind, 'unknown');
    });
  }
});

test('DD5-structured-timeouts: structured runner failureKind maps to exact public blocked reasons', async () => {
  for (const failureKind of [RUNNER_IDLE_TIMEOUT_KIND, RUNNER_WALL_CLOCK_LIMIT_KIND]) {
    const { run, rec } = buildAdapter({
      results: {
        developer: {
          output: {
            verdict: 'BLOCKER',
            error: 'runner_failed',
            role: 'developer',
            stepKey: 'developer',
            reason: `${failureKind}: elapsed 650000ms`,
            failureKind,
            retryableCandidate: true,
            timing: {
              idleTimeoutMs: 600_000,
              wallClockLimitMs: 3_600_000,
              elapsedMs: 650_000,
              idleMs: 600_001,
              lastActivityAt: '2026-06-26T10:00:00.000Z',
              inFlightOperationCount: 0,
              stdoutBytes: 10,
              stderrBytes: 0,
              eventCount: 3,
            },
          },
          verdict: 'BLOCKER',
          nextSteps: [],
          costs: [],
          needsHuman: true,
          lesson: `${failureKind}: elapsed 650000ms`,
        },
      },
    });

    const result = await run();
    assert.equal(result.status, 'blocked', `${failureKind} blocks recoverably`);
    assert.equal(rec.blocked[0]?.reason, failureKind);
    assert.ok(
      rec.blockedLessons.some((lesson) => lesson.includes(failureKind)),
      `${failureKind} is visible in the blocked lesson`,
    );
  }
});

test('DD5b: markdown output with no top-level verdict is not scanned and fails as revo.ResultInvalid', async () => {
  const tmpl = template('verdict-required')
    .specVersion('1.0')
    .entry('review')
    .domain('approved', 'blocker')
    .add(
      node.agent('review', 'role:reviewer', 'router', { resultSchema: 'schema:review', onFailure: 'abort' }),
      node.choice('router', [on(verdictEq('approved'), 'done'), otherwise('blocked')]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
    )
    .build();
  const { run, rec } = buildAdapter({
    template: tmpl,
    results: { review: { output: '# Plan approved\nLooks good.', nextSteps: [], costs: [], needsHuman: false } },
  });

  const result = await run();
  assert.equal(result.status, 'failed');
  assert.equal(rec.blocked.length, 0, 'missing verdict must not fall through to the default branch');
  assert.ok(rec.events.some((e) => e === 'step_failed:review'), 'invalid result emits step_failed');
  assert.match(rec.failed[0] ?? '', /revo\.ResultInvalid/);
});

test('DD5c: top-level verdict outside template domain fails as revo.ResultInvalid', async () => {
  const tmpl = template('verdict-domain')
    .specVersion('1.0')
    .entry('review')
    .domain('approved', 'blocker')
    .add(
      node.agent('review', 'role:reviewer', 'router', { resultSchema: 'schema:review', onFailure: 'abort' }),
      node.choice('router', [on(verdictEq('approved'), 'done'), otherwise('blocked')]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
    )
    .build();
  const { run, rec } = buildAdapter({
    template: tmpl,
    results: { review: { output: 'summary', verdict: 'PASS', nextSteps: [], costs: [], needsHuman: false } },
  });

  const result = await run();
  assert.equal(result.status, 'failed');
  assert.match(rec.failed[0] ?? '', /revo\.ResultInvalid/);
  assert.ok(rec.events.some((e) => e === 'step_failed:review'), 'invalid domain verdict emits step_failed');
});

test('DD5d: the adapter threads the active template accepted-verdict domain to each agent step (issue #207)', async () => {
  const tmpl = template('verdict-vocab')
    .specVersion('1.0')
    .entry('review')
    .domain('approved', 'blocker')
    .add(
      node.agent('review', 'role:reviewer', 'router', { resultSchema: 'schema:review', onFailure: 'abort' }),
      node.choice('router', [on(verdictEq('approved'), 'done'), otherwise('blocked')]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
    )
    .build();
  const { run, rec } = buildAdapter({ template: tmpl, verdicts: { review: 'approved' } });

  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    rec.acceptedVerdictsByStep['review'],
    ['approved', 'blocker'],
    'the runner is offered exactly the template domain — not a wider global menu the engine would reject',
  );
});

test('DD5e: a narrow single-token domain (local-change) reaches the agent step verbatim (issue #207)', async () => {
  const { run, rec } = buildAdapter({
    template: localChange(),
    route: {
      ...makeRoute(),
      roleBindings: [binding('orchestrator', 'claude-code'), binding('developer', 'claude-code')],
    },
    verdicts: { orchestrator: 'approved', developer: 'approved' },
  });

  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.acceptedVerdictsByStep['orchestrator'], ['approved']);
  assert.deepEqual(rec.acceptedVerdictsByStep['developer'], ['approved']);
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

test('retry policy env: defaults, overrides, and invalid set values fail loud', () => {
  assert.deepEqual(resolveRunnerTransientRetryPolicy({} as NodeJS.ProcessEnv), {
    maxAttempts: 2,
    backoffMs: 2_000,
  });
  assert.deepEqual(
    resolveRunnerTransientRetryPolicy({
      REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS: '3',
      REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS: '0',
    } as NodeJS.ProcessEnv),
    { maxAttempts: 3, backoffMs: 0 },
  );
  assert.throws(
    () => resolveRunnerTransientRetryPolicy({ REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS: '0' } as NodeJS.ProcessEnv),
    /REVO_RUNNER_TRANSIENT_MAX_ATTEMPTS must be a positive integer/,
  );
  assert.throws(
    () => resolveRunnerTransientRetryPolicy({ REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS: '-1' } as NodeJS.ProcessEnv),
    /REVO_RUNNER_TRANSIENT_RETRY_BACKOFF_MS must be a non-negative integer/,
  );
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
  assert.deepEqual(rec.inputsByStep['developer'], { plan: { from: 'analyst' } });
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
