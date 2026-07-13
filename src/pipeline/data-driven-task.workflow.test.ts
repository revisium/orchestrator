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
import { readFileSync } from 'node:fs';
import { makeDataDrivenTask, resolveRunnerTransientRetryPolicy, scriptGithubAccount, type DataDrivenProgressCursor, type DataDrivenTaskDeps, type GateSummary, type RunnerTransientRetryPolicy } from './data-driven-task.workflow.js';
import { templateFromExecutionPolicy } from './data-driven-template.js';
import { featureDevelopment, featureDevelopmentPrReview, confirmMergeFlow, localChange } from '../pipeline-core/kit/fixtures.js';
import { hashTemplate, materializeTemplate } from '../pipeline-core/materialize.js';
import { topologyProfileFromRunProfile } from '../control-plane/run-profiles.js';
import { compileExecutionPlan } from '../control-plane/run-profile-contract.js';
import type { ResolvedAgentBinding } from '../control-plane/run-profile-contract.js';
import { runnerManifests } from '../runners/runner-manifest.js';
import type { Template } from '../pipeline-core/index.js';
import type { AttemptResult } from '../worker/runner.js';
import type { AppendEventInput } from '../run/append-event.js';
import { routeDecisionFromCompiledPlan, type RouteDecision } from './route-contract.js';
import type { Decision as GateDecision, GateTopic } from './await-human.js';
import type {
  IntegratorInput,
  IntegratorOutput,
  IntegratorBlocked,
  ConfirmMergeOutput,
  PrFeedback,
  MergeOverrideOutput,
  RespondThreadsOutput,
  ProducedChangeArtifact,
} from '../runners/integrator.js';
import { template, node, on, otherwise, verdictEq, allOf, counterLt, joinAll } from '../pipeline-core/kit/index.js';
import { RUNNER_IDLE_TIMEOUT_KIND, RUNNER_WALL_CLOCK_LIMIT_KIND } from '../worker/process-executor.js';
import type { IssueAction, IssueRef } from '../run/issue-ref.js';

const RUN_ID = 'run-dd-001';

test('script execution fails closed when its pinned binding is absent', () => {
  assert.throws(
    () => scriptGithubAccount({ type: 'invokeScript', nodeId: 'integrator', scriptRef: 'script:integrator' } as never, []),
    /execution_plan_binding_unresolved: script node integrator has no pinned binding/,
  );
});

type PipelineCatalogEntry = {
  id: string;
  execution_policy: unknown;
};
type RunProfileCatalogEntry = {
  id: string;
  pipelineId: string;
  topology: unknown;
  bindings: unknown;
  status: string;
};

const defaultPlaybookPipelines = JSON.parse(
  readFileSync(new URL('../../control-plane/default-playbook/catalog/pipelines.json', import.meta.url), 'utf8'),
) as PipelineCatalogEntry[];
const defaultPlaybookRunProfiles = JSON.parse(
  readFileSync(new URL('../../control-plane/default-playbook/catalog/run-profiles.json', import.meta.url), 'utf8'),
) as RunProfileCatalogEntry[];

function exactRouteForTemplate(template: Template): RouteDecision {
  const manifests = runnerManifests();
  const codex = manifests.codex;
  assert.ok(codex, 'codex runner manifest exists');
  const agentBindings: ResolvedAgentBinding[] = Object.values(template.nodes)
    .filter((node): node is Extract<Template['nodes'][string], { kind: 'agent' }> => node.kind === 'agent')
    .map((node) => ({
      slotKey: `node:${node.id}`,
      nodeId: node.id,
      roleId: node.roleRef.replace(/^role:/, ''),
      roleDocumentId: node.roleRef.replace(/^role:/, ''),
      runnerId: codex.runnerId,
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
      modelParams: {},
      permissionMode: 'workspace-write',
      permissionSource: 'profile',
      runner: codex,
    }));
  const scriptBindings = Object.values(template.nodes)
    .filter((node): node is Extract<Template['nodes'][string], { kind: 'script' }> => node.kind === 'script')
    .map((node) => ({
      nodeId: node.id,
      scriptRef: node.scriptRef,
      accountAliases: { github: 'profile-bot' },
    }));
  return routeDecisionFromCompiledPlan(compileExecutionPlan({
    selection: {
      playbookId: 'pb',
      pipelineId: template.pipelineId,
      pipelineRowId: `pb-${template.pipelineId}`,
      source: 'explicit',
    },
    businessParams: {},
    profile: { source: 'inline', profileHash: `sha256:${'0'.repeat(64)}` },
    pipeline: {
      executableGraph: template,
      graphDigest: hashTemplate(template),
      materializerVersion: 'test',
      policyVersion: 'test',
      routeGates: [],
      executionPolicy: { template_json: template },
    },
    agentBindings,
    scriptBindings,
  }));
}


function defaultConsensusProfileTemplate(): Template {
  const pipeline = defaultPlaybookPipelines.find((candidate) => candidate.id === 'feature-development');
  assert.ok(pipeline, 'bundled feature-development pipeline exists');
  const base = templateFromExecutionPolicy(pipeline.execution_policy);
  assert.ok(base, 'bundled feature-development carries a valid template_json');
  const profile = defaultPlaybookRunProfiles.find((candidate) => candidate.id === 'codex-gpt-5-6-luna-claude-opus-4-8-consensus');
  assert.ok(profile, 'bundled consensus run profile exists');
  const { template } = materializeTemplate(
    base,
    topologyProfileFromRunProfile(profile as never),
  );
  return template;
}

type Recorder = {
  gates: string[];
  gateSummaries: GateSummary[];
  completed: Array<{ verdict?: string }>;
  cancelled: Array<{ source?: string }>;
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
  timeline: string[];
  /** Persisted step outputs (0016 dataflow). */
  outputs: Array<{ nodeId: string; ordinal: number; name: string; payload: unknown; attemptId?: string }>;
  /** Captured change artifacts (issue #140 handoff contract). */
  capturedChanges: ProducedChangeArtifact[];
  /** issueRef values passed into worktree creation. */
  worktreeIssueRefs: Array<IssueRef | undefined>;
  /** Hydrated `inputs` the adapter passed to each step, keyed by stepKey (0016 consumes). */
  inputsByStep: Record<string, unknown>;
  stepInputsByStep: Record<string, unknown>;
  stepInputs: Array<{ stepKey: string; attemptNo?: number; input: unknown }>;
  runStepAttempts: Array<{ stepKey: string; attemptNo?: number; attemptId?: string }>;
  acceptedVerdictsByStep: Record<string, readonly string[] | undefined>;
  retrySleeps: number[];
  progress: DataDrivenProgressCursor[];
  gateKeys: string[];
};

/**
 * Build the adapter from a per-node verdict script + a gate decider. `runStepFn` returns the scripted
 * top-level domain verdict for the node id; an absent entry returns `approved`.
 */
function buildAdapter(opts: {
  verdicts?: Record<string, string | string[]>;
  gate?: (topic: GateTopic, gateKey: string, summary: GateSummary) => GateDecision;
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
  /** Override overrideMerge (default: clean). Lets a test drive override refusals. */
  overrideMerge?: (input: IntegratorInput) => MergeOverrideOutput | IntegratorBlocked | Promise<MergeOverrideOutput | IntegratorBlocked>;
  /** Override respondThreads (default: replied/resolved 0). Lets a test capture the triage it consumed. */
  respondThreads?: (input: IntegratorInput) => RespondThreadsOutput | IntegratorBlocked | Promise<RespondThreadsOutput | IntegratorBlocked>;
  /** Exact per-node result override for invalid-result contract tests. */
  results?: Record<string, AttemptResult | AttemptResult[]>;
  retryPolicy?: RunnerTransientRetryPolicy;
  onSleep?: (ms: number) => void | Promise<void>;
  issueRef?: IssueRef;
  issueAction?: IssueAction;
}) {
  const rec: Recorder = {
    gates: [],
    gateSummaries: [],
    completed: [],
    cancelled: [],
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
    timeline: [],
    outputs: [],
    capturedChanges: [],
    worktreeIssueRefs: [],
    inputsByStep: {},
    stepInputsByStep: {},
    stepInputs: [],
    runStepAttempts: [],
    acceptedVerdictsByStep: {},
    retrySleeps: [],
    progress: [],
    gateKeys: [],
  };
  const visits = new Map<string, number>();

  const runStepFn = async (
    _runId: string,
    _role: string,
    stepKey: string,
    input: unknown,
    _binding: ResolvedAgentBinding,
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
    rec.stepInputsByStep[stepKey] = input;
    rec.stepInputs.push({ stepKey, attemptNo: physicalAttempt?.attemptNo, input });
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
    appendRunOutput: async (o) => { rec.timeline.push(`output:${o.nodeId}`); rec.outputs.push({ nodeId: o.nodeId, ordinal: o.ordinal, name: o.name, payload: o.payload, attemptId: o.attemptId }); },
    setProgress: async (_runId, cursor) => { rec.timeline.push(`progress:${cursor.activeNodeIds.join(',')}`); rec.progress.push(cursor); },
    sleep: async (ms) => {
      rec.retrySleeps.push(ms);
      await opts.onSleep?.(ms);
    },
    awaitHuman: async (_runId, topic, _gateKey, _title, summary): Promise<GateDecision> => {
      rec.gates.push(topic);
      rec.gateKeys.push(_gateKey);
      rec.gateSummaries.push(summary as GateSummary);
      return (opts.gate ?? (() => ({ decision: 'approve' })))(topic, _gateKey, summary as GateSummary);
    },
    completeRun: async (_runId, o) => { rec.completed.push({ verdict: o?.verdict }); return null; },
    failRun: async (_runId, reason) => { rec.failed.push(reason); return null; },
    blockRun: async (_runId, o) => { rec.blocked.push({ reason: o?.reason }); return null; },
    cancelRun: async (_runId, o) => { rec.cancelled.push({ source: o?.source }); return null; },
    loadRunTaskContext: async () => ({
      taskId: 'task-1',
      title: 'T',
      base: 'master',
      repoRef: '',
      issueRef: opts.issueRef,
      issueAction: opts.issueAction,
    }),
    integrateFn: async (input: IntegratorInput): Promise<IntegratorOutput | IntegratorBlocked> => {
      rec.integrateCalls++;
      rec.integratorInputs.push(input);
      if (opts.integrate) return opts.integrate(input);
      return { prUrl: `https://example/pr/${input.taskId}`, branch: 'feat/x', prNumber: 1 };
    },
    // Live script nodes trigger preflight. By default it passes (these tests exercise the graph);
    // a test can override it.
    preflightFn: async () => (opts.preflight ? opts.preflight() : { ok: true }),
    // Per-run worktree lifecycle (plan 0017) — fakes here record create/release ordering via events;
    // live templates create after preflight, and release fires via the explicit cleanupWorktree
    // pipeline step (not an engine-level finally).
    createWorktreeFn: async (_runId, _taskId, _title, _base, issueRef) => {
      rec.events.push('worktree_create:pipeline');
      rec.worktreeIssueRefs.push(issueRef);
      return { worktreePath: '/fake/worktree' };
    },
    releaseWorktreeFn: async () => {
      rec.events.push('worktree_release:pipeline');
      return { released: true, worktreePath: '/fake/worktree' };
    },
    // confirmMerge (plan 0017 follow-up): default fake reports merged; a test can override via opts.confirmMerge.
    confirmMergeFn: async (input: IntegratorInput) => {
      rec.confirmMergeCalls++;
      rec.confirmMergeInputs.push(input);
      if (opts.confirmMerge) return opts.confirmMerge(input);
      return { merged: true as const, prNumber: 1, prUrl: `https://example/pr/${input.taskId}/merged` };
    },
    overrideMergeFn: async (input: IntegratorInput): Promise<MergeOverrideOutput | IntegratorBlocked> => {
      if (opts.overrideMerge) return opts.overrideMerge(input);
      return {
        prNumber: 1,
        headSha: 'ready-head',
        evidence: [`overrideMerge call for ${input.taskId}: clean`],
        verdict: 'clean' as const,
        ciFailures: [],
        reviewThreads: [],
        override: { accepted: true, actor: 'test', note: 'test override', source: { gate: 'mergeGate' as const, inboxId: 'inbox-test' }, facts: [], replied: 0, resolved: 0 },
      };
    },
    // pollPr (plan 0018): default fake reports a CLEAN PR so the loop converges to the merge gate.
    pollPrFn: async (input: IntegratorInput): Promise<PrFeedback | IntegratorBlocked> => {
      rec.pollPrCalls++;
      if (opts.pollPr) return opts.pollPr(input);
      return {
        prNumber: 1,
        headSha: 'ready-head',
        evidence: [`pollPr call ${rec.pollPrCalls}: clean`],
        verdict: 'clean' as const,
        ciFailures: [],
        reviewThreads: [],
      };
    },
    // respondThreads (plan 0018): capture the consumed triage; default reports nothing to reply/resolve.
    respondThreadsFn: async (input: IntegratorInput): Promise<RespondThreadsOutput | IntegratorBlocked> => {
      rec.respondCalls++;
      rec.respondTriage.push(input.triage);
      if (opts.respondThreads) return opts.respondThreads(input);
      return { replied: 0, resolved: 0 };
    },
    captureChangeFn: async (input) => {
      const change: ProducedChangeArtifact = {
        branch: `feat/${input.taskId}`,
        headSha: `sha-${input.nodeId}-${input.attemptId}`,
        worktreePath: '/fake/worktree',
        ...(input.issueRef ? { issueRef: input.issueRef } : {}),
        ...(input.issueAction ? { issueAction: input.issueAction } : {}),
        ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
      };
      rec.capturedChanges.push(change);
      return change;
    },
  };

  const template = opts.template ?? featureDevelopment();
  const fn = makeDataDrivenTask(runStepFn, deps);
  const route = exactRouteForTemplate(template);
  return {
    run: () => fn(RUN_ID, {
      route,
      runnerRetryPolicy: opts.retryPolicy ?? resolveRunnerTransientRetryPolicy(),
    }),
    rec,
  };
}

function baseStepKey(stepKey: string): string {
  return stepKey.includes('#') ? stepKey.slice(0, stepKey.indexOf('#')) : stepKey;
}

function attemptCount(rec: Recorder, nodeId: string): number {
  return rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === nodeId).length;
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

function cancelGateTemplate(): Template {
  return template('cancel-gate')
    .specVersion('1.0')
    .entry('gate')
    .domain('approved', 'cancel')
    .add(
      node.humanGate('gate', 'plan-review', ['approved', 'cancel'], [
        on(verdictEq('approved'), 'done'),
        on(verdictEq('cancel'), 'cancelled'),
        otherwise('blocked'),
      ]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
      node.terminal('cancelled', 'cancelled'),
    )
    .build();
}

function mergeRecheckWaitGateTemplate(): Template {
  return template('merge-recheck-wait-gate')
    .specVersion('1.0')
    .entry('mergeRecheck')
    .domain('clean', 'approved', 'cancel')
    .add(
      node.script('mergeRecheck', 'script:pollPr', 'settle', {
        resultSchema: 'schema:prFeedback',
        produces: { name: 'prFeedback' },
      }),
      node.wait('settle', 'PT1S', 'mergeGate'),
      node.humanGate('mergeGate', 'merge-review', ['approved', 'cancel'], [
        on(verdictEq('approved'), 'done'),
        on(verdictEq('cancel'), 'cancelled'),
        otherwise('blocked'),
      ]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
      node.terminal('cancelled', 'cancelled'),
    )
    .build();
}

function parallelConsensusTemplate(): Template {
  return template('parallel-consensus')
    .specVersion('1.0')
    .entry('fanout')
    .domain('approved', 'clean', 'changes_requested', 'blocker')
    .add(
      node.parallel('fanout', [
        { id: 'primary', entry: 'primaryReview' },
        { id: 'secondary', entry: 'secondaryReview' },
      ], 'reviewJoin'),
      node.agent('primaryReview', 'role:reviewer', 'reviewJoin', {
        resultSchema: 'schema:reviewVerdict',
        produces: { name: 'review' },
      }),
      node.agent('secondaryReview', 'role:reviewer', 'reviewJoin', {
        resultSchema: 'schema:reviewVerdict',
        produces: { name: 'review' },
      }),
      node.join('reviewJoin', joinAll(), 'reviewRouter', {
        merge: { reviews: 'appendByBranchOrder' },
        verdictReducer: { kind: 'allIn', pass: ['approved', 'clean'], passVerdict: 'approved', failVerdict: 'changes_requested' },
      }),
      node.choice('reviewRouter', [on(verdictEq('approved'), 'done'), otherwise('blocked')]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
    )
    .build();
}

function analysisConsensusTemplate(): Template {
  return template('analysis-only')
    .specVersion('1.0')
    .entry('analystFanout')
    .domain('approved')
    .add(
      node.parallel('analystFanout', [
        { id: 'primary', entry: 'analystPrimary' },
        { id: 'secondary', entry: 'analystSecondary' },
      ], 'analystJoin'),
      node.agent('analystPrimary', 'role:analyst', 'analystJoin', {
        onFailure: 'abort', resultSchema: 'schema:analysis', produces: { name: 'analysis' },
      }),
      node.agent('analystSecondary', 'role:analyst', 'analystJoin', {
        onFailure: 'abort', resultSchema: 'schema:analysis', produces: { name: 'analysis' },
      }),
      node.join('analystJoin', joinAll(), 'done', { merge: { analysis: 'appendByBranchOrder' } }),
      node.terminal('done', 'succeeded'),
    )
    .build();
}

function parallelConsensusAfterPreApprovedTemplate(): Template {
  return template('parallel-consensus-after-pre-approved')
    .specVersion('1.0')
    .entry('precheck')
    .domain('approved', 'clean', 'changes_requested', 'blocker')
    .add(
      node.agent('precheck', 'role:reviewer', 'fanout', {
        resultSchema: 'schema:reviewVerdict',
      }),
      node.parallel('fanout', [
        { id: 'primary', entry: 'primaryReview' },
        { id: 'secondary', entry: 'secondaryBypass' },
      ], 'reviewJoin'),
      node.agent('primaryReview', 'role:reviewer', 'reviewJoin', {
        resultSchema: 'schema:reviewVerdict',
        produces: { name: 'review' },
      }),
      node.choice('secondaryBypass', [otherwise('reviewJoin')]),
      node.join('reviewJoin', joinAll(), 'reviewRouter', {
        merge: { reviews: 'appendByBranchOrder' },
        verdictReducer: { kind: 'allIn', pass: ['approved', 'clean'], passVerdict: 'approved', failVerdict: 'changes_requested' },
      }),
      node.choice('reviewRouter', [on(verdictEq('approved'), 'done'), otherwise('blocked')]),
      node.terminal('done', 'succeeded'),
      node.terminal('blocked', 'blocked'),
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
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: () => {
      pollCount++;
      return {
        prNumber: 1,
        headSha: 'ready-head',
        evidence: [`pollPr call ${pollCount}: clean`],
        verdict: 'clean' as const,
        ciFailures: [],
        reviewThreads: [],
      };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['plan', 'merge'], 'both humanGate nodes opened, in order');
  assert.equal(rec.completed.length, 1, 'completeRun called once');
  assert.equal(rec.integrateCalls, 1, 'the integrator script ran once');
  assert.ok(rec.events.includes('integrate_succeeded:integrator'), 'integrate_succeeded emitted at the script node');
  assert.equal(rec.pollPrCalls, 3, 'pollPr + mergeReadiness + mergeApproveReverify re-poll fresh readiness after approval');
  const mergeSummary = rec.gateSummaries.find((summary) => summary.nodeId === 'mergeGate');
  assert.equal(mergeSummary?.gatedArtifact?.nodeId, 'mergeReadiness', 'merge gate surfaces the fresh readiness artifact');
  assert.deepEqual(
    (mergeSummary?.gatedArtifact?.payload as { headSha?: string; evidence?: string[] } | undefined),
    {
      prNumber: 1,
      headSha: 'ready-head',
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
    { headSha: 'ready-head' },
    'confirmMerge consumes the post-approval mergeApproveReverify head sha for the GitHub merge guard',
  );
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
});

test('DD-issue-274: moved head after merge approval reopens mergeGate with the reverify artifact', async () => {
  let pollCount = 0;
  let mergeSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (topic, _gateKey, summary) => {
      if (topic !== 'merge') return { decision: 'approve' };
      mergeSeen++;
      const payload = summary.gatedArtifact?.payload as { headSha?: string } | undefined;
      if (mergeSeen === 1) {
        assert.equal(payload?.headSha, 'deadbeefcafe');
        return { decision: 'approve' };
      }
      assert.equal(payload?.headSha, 'feedfacecafe');
      return { outcome: 'cancel' };
    },
    pollPr: () => {
      pollCount++;
      const headSha = pollCount >= 3 ? 'feedfacecafe' : 'deadbeefcafe';
      return {
        prNumber: 1,
        headSha,
        evidence: [`poll ${pollCount}: ${headSha}`],
        verdict: 'clean' as const,
        ciFailures: [],
        reviewThreads: [],
      };
    },
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(rec.gates, ['plan', 'merge', 'merge']);
  assert.equal(rec.pollPrCalls, 3);
  assert.equal(rec.confirmMergeCalls, 0);
  assert.ok(!rec.events.some((event) => event.startsWith('merge_confirmed:')));
});

test('DD-issue-279: override refused on trusted gate head mismatch never calls confirmMerge', async () => {
  const note = 'operator reviewed advisory thread';
  const audit = {
    reason: 'operator accepts advisory concern',
    risk: 'known reviewer concern may remain',
    verificationResponsibility: 'operator verified locally',
    headSha: 'new-head',
  };
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: 'approved',
      planReviewSecondary: 'approved',
      codeReviewPrimary: 'approved',
      codeReviewSecondary: 'approved',
    },
    gate: (_topic, _gateKey, summary) => {
      if (summary.nodeId === 'recoveryGate') return { outcome: 'cancel' };
      if (summary.nodeId === 'mergeGate') {
        assert.equal((summary.gatedArtifact?.payload as { headSha?: string } | undefined)?.headSha, 'old-head');
        return {
          outcome: 'override_merge',
          note,
          mergeOverrideAudit: {
            threadIds: [],
            actor: 'human',
            ...audit,
          },
        };
      }
      return { decision: 'approve' };
    },
    pollPr: () => ({
      prNumber: 1,
      headSha: 'old-head',
      evidence: ['pollPr clean old-head'],
      verdict: 'clean' as const,
      ciFailures: [],
      reviewThreads: [],
    }),
    overrideMerge: (input) => {
      const gateResolution = input.gateResolution as Record<string, unknown>;
      assert.equal(gateResolution['trustedGateHeadSha'], 'old-head');
      assert.deepEqual(gateResolution['mergeOverrideAudit'], { threadIds: [], actor: 'human', ...audit });
      return {
        prNumber: 1,
        headSha: 'new-head',
        evidence: ['overrideMerge verdict=recheck'],
        verdict: 'recheck' as const,
        ciFailures: [],
        reviewThreads: [],
        override: {
          accepted: false,
          actor: 'human',
          note,
          audit,
          source: { gate: 'mergeGate', inboxId: 'mergeGate' },
          facts: [{ severity: 'hard', kind: 'head_moved', summary: 'approved head old-head no longer matches fresh head new-head' }],
          replied: 0,
          resolved: 0,
          reason: 'override_merge refused because hard blockers remain',
        },
      };
    },
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.equal(rec.confirmMergeCalls, 0);
  const refused = rec.eventRecords.find((event) => event.type === 'merge_override_refused');
  assert.ok(refused, 'refused override is durably audited');
  assert.deepEqual(refused.payload, {
    actor: 'human',
    note,
    reason: audit.reason,
    risk: audit.risk,
    verificationResponsibility: audit.verificationResponsibility,
    headSha: audit.headSha,
    freshHeadSha: 'new-head',
    prNumber: 1,
    source: { gate: 'mergeGate', inboxId: 'mergeGate' },
    overriddenFacts: [{ severity: 'hard', kind: 'head_moved', summary: 'approved head old-head no longer matches fresh head new-head' }],
    replied: 0,
    resolved: 0,
    refusalReason: 'override_merge refused because hard blockers remain',
  });
});

test('cancel gate outcome reaches cancelled terminal and calls cancelRun', async () => {
  const { run, rec } = buildAdapter({
    template: cancelGateTemplate(),
    gate: () => ({ outcome: 'cancel', resolvedBy: 'test' }),
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.deepEqual(rec.gates, ['plan']);
  assert.deepEqual(rec.cancelled, [{ source: 'data-driven-cancelled' }]);
  assert.equal(rec.completed.length, 0);
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
  assert.ok(rec.events.includes('pipeline_cancelled:pipeline'));
});

test('gate summaries preserve the latest produced artifact across non-producing adapter effects', async () => {
  const { run, rec } = buildAdapter({
    template: mergeRecheckWaitGateTemplate(),
    gate: () => ({ outcome: 'cancel' }),
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.equal(rec.gateSummaries[0]?.nodeId, 'mergeGate');
  assert.equal(rec.gateSummaries[0]?.gatedArtifact?.nodeId, 'mergeRecheck');
  assert.deepEqual(
    rec.gateSummaries[0]?.gatedArtifact?.payload,
    {
      prNumber: 1,
      headSha: 'ready-head',
      evidence: ['pollPr call 1: clean'],
      verdict: 'clean',
      ciFailures: [],
      reviewThreads: [],
    },
  );
});

test('DD-parallel: fork executes both reviewer branches and feeds two join arrivals', async () => {
  const { run, rec } = buildAdapter({
    template: parallelConsensusTemplate(),
    verdicts: { primaryReview: 'approved', secondaryReview: 'approved' },
  });

  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(
    rec.runStepAttempts.map((attempt) => attempt.stepKey).sort(),
    ['primaryReview', 'secondaryReview'],
  );
  assert.deepEqual(
    rec.outputs.map((o) => ({ nodeId: o.nodeId, ordinal: o.ordinal, name: o.name })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    [
      { nodeId: 'primaryReview', ordinal: 1, name: 'review' },
      { nodeId: 'secondaryReview', ordinal: 1, name: 'review' },
    ],
  );
  const joinProgress = rec.progress.find((cursor) =>
    cursor.activeNodeIds.length === 1 &&
    cursor.activeNodeIds[0] === 'reviewJoin' &&
    cursor.lastResult?.joinArrivals?.length === 2,
  );
  assert.deepEqual(joinProgress?.lastResult?.joinArrivals, [
    { branchId: 'primary', seq: 1, verdict: 'approved' },
    { branchId: 'secondary', seq: 2, verdict: 'approved' },
  ]);
});

test('DD-parallel analysis consensus keeps separate branch outputs before join progress', async () => {
  const { run, rec } = buildAdapter({ template: analysisConsensusTemplate() });

  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.runStepAttempts.map((attempt) => attempt.stepKey).sort(), ['analystPrimary', 'analystSecondary']);
  assert.deepEqual(rec.outputs.map((output) => ({ nodeId: output.nodeId, ordinal: output.ordinal, name: output.name })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)), [
    { nodeId: 'analystPrimary', ordinal: 1, name: 'analysis' },
    { nodeId: 'analystSecondary', ordinal: 1, name: 'analysis' },
  ]);
  assert.equal(rec.outputs.some((output) => output.nodeId === 'analystJoin'), false);
  const joinProgressIndex = rec.timeline.findIndex((entry) => entry === 'progress:analystJoin');
  assert.ok(joinProgressIndex >= 0, `expected analystJoin progress; timeline=${rec.timeline.join(',')}`);
  for (const nodeId of ['analystPrimary', 'analystSecondary']) {
    const outputIndex = rec.timeline.indexOf(`output:${nodeId}`);
    assert.ok(outputIndex >= 0, `expected persisted output for ${nodeId}`);
    assert.ok(outputIndex < joinProgressIndex, `${nodeId} output must be persisted before join progress`);
  }
  const joinProgress = rec.progress.find((cursor) => cursor.activeNodeIds.length === 1 && cursor.activeNodeIds[0] === 'analystJoin');
  assert.deepEqual(joinProgress?.lastResult?.joinArrivals, [
    { branchId: 'primary', seq: 1, verdict: 'approved' },
    { branchId: 'secondary', seq: 2, verdict: 'approved' },
  ]);
});

test('DD-parallel: consensus passes when reviewers return approved plus clean', async () => {
  const { run, rec } = buildAdapter({
    template: parallelConsensusTemplate(),
    verdicts: { primaryReview: 'approved', secondaryReview: 'clean' },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  const joinProgress = rec.progress.find((cursor) =>
    cursor.activeNodeIds.length === 1 &&
    cursor.activeNodeIds[0] === 'reviewJoin' &&
    cursor.lastResult?.joinArrivals?.length === 2,
  );
  assert.deepEqual(joinProgress?.lastResult?.joinArrivals, [
    { branchId: 'primary', seq: 1, verdict: 'approved' },
    { branchId: 'secondary', seq: 2, verdict: 'clean' },
  ]);
});

test('DD-parallel: branch without a verdict does not inherit the pre-fork verdict', async () => {
  const { run, rec } = buildAdapter({
    template: parallelConsensusAfterPreApprovedTemplate(),
    verdicts: { precheck: 'approved', primaryReview: 'approved' },
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  const joinProgress = rec.progress.find((cursor) =>
    cursor.activeNodeIds.length === 1 &&
    cursor.activeNodeIds[0] === 'reviewJoin' &&
    cursor.lastResult?.joinArrivals?.length === 2,
  );
  assert.deepEqual(joinProgress?.lastResult?.joinArrivals, [
    { branchId: 'primary', seq: 1, verdict: 'approved' },
    { branchId: 'secondary', seq: 2 },
  ]);
});

test('DD-parallel: consensus blocks when either reviewer is non-approved, regardless of branch order', async () => {
  const cases: Array<{ name: string; verdicts: Record<string, string> }> = [
    {
      name: 'primary requests changes, secondary approves',
      verdicts: { primaryReview: 'changes_requested', secondaryReview: 'approved' },
    },
    {
      name: 'primary approves, secondary requests changes',
      verdicts: { primaryReview: 'approved', secondaryReview: 'changes_requested' },
    },
    {
      name: 'primary approves, secondary blocks',
      verdicts: { primaryReview: 'approved', secondaryReview: 'blocker' },
    },
    {
      name: 'primary is clean, secondary requests changes',
      verdicts: { primaryReview: 'clean', secondaryReview: 'changes_requested' },
    },
  ];

  for (const c of cases) {
    const { run, rec } = buildAdapter({
      template: parallelConsensusTemplate(),
      verdicts: c.verdicts,
    });

    const result = await run();

    assert.equal(result.status, 'blocked', c.name);
    assert.deepEqual(
      rec.outputs.map((o) => ({ nodeId: o.nodeId, name: o.name })).sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      [
        { nodeId: 'primaryReview', name: 'review' },
        { nodeId: 'secondaryReview', name: 'review' },
      ],
      `${c.name}: both reviewer outputs are still recorded before the consensus verdict routes`,
    );
  }
});

test('DD-parallel: consensus blocks when both reviewers are non-approved', async () => {
  const { run, rec } = buildAdapter({
    template: parallelConsensusTemplate(),
    verdicts: { primaryReview: 'changes_requested', secondaryReview: 'blocker' },
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  const joinProgress = rec.progress.find((cursor) =>
    cursor.activeNodeIds.length === 1 &&
    cursor.activeNodeIds[0] === 'reviewJoin' &&
    cursor.lastResult?.joinArrivals?.length === 2,
  );
  assert.deepEqual(joinProgress?.lastResult?.joinArrivals, [
    { branchId: 'primary', seq: 1, verdict: 'changes_requested' },
    { branchId: 'secondary', seq: 2, verdict: 'blocker' },
  ]);
});

test('DD-default-codex: plan consensus reworks when one reviewer is non-approved, then proceeds after both pass', async () => {
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: ['changes_requested', 'approved'],
      planReviewSecondary: ['approved', 'clean'],
      codeReviewPrimary: 'approved',
      codeReviewSecondary: 'approved',
    },
    gate: () => ({ decision: 'approve' }),
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(attemptCount(rec, 'analyst'), 2, 'plan rework reruns the analyst once');
  assert.equal(attemptCount(rec, 'planReviewPrimary'), 2);
  assert.equal(attemptCount(rec, 'planReviewSecondary'), 2);
  assert.equal(attemptCount(rec, 'developer'), 1, 'developer starts only after plan consensus passes');
  assert.equal(attemptCount(rec, 'codeReviewPrimary'), 1);
  assert.equal(rec.integrateCalls, 1);
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planGate', 'mergeGate']);
});

test('DD-default-codex: code consensus reworks when one reviewer is non-approved, then integrates after both pass', async () => {
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: 'approved',
      planReviewSecondary: 'approved',
      codeReviewPrimary: ['approved', 'clean'],
      codeReviewSecondary: ['blocker', 'approved'],
    },
    gate: () => ({ decision: 'approve' }),
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(attemptCount(rec, 'developer'), 1);
  assert.equal(attemptCount(rec, 'reworkDeveloper'), 1, 'code consensus failure routes through developer rework');
  assert.equal(attemptCount(rec, 'codeReviewPrimary'), 2);
  assert.equal(attemptCount(rec, 'codeReviewSecondary'), 2);
  assert.equal(rec.integrateCalls, 1, 'integrator runs only after the reworked code consensus passes');
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planGate', 'mergeGate']);
});

test('DD-default-codex: repeated plan consensus failures hit planStuckGate at the cap', async () => {
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: 'changes_requested',
      planReviewSecondary: 'approved',
    },
    gate: () => ({ decision: 'reject' }),
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.equal(attemptCount(rec, 'analyst'), 5);
  assert.equal(attemptCount(rec, 'planReviewPrimary'), 5);
  assert.equal(attemptCount(rec, 'planReviewSecondary'), 5);
  assert.equal(attemptCount(rec, 'developer'), 0, 'developer never runs before plan consensus is unstuck');
  assert.equal(rec.integrateCalls, 0);
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planStuckGate']);
});

test('DD-default-codex: codeStuckGate rework runs bounded recovery then returns to consensus review', async () => {
  let planTopicGates = 0;
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: 'approved',
      planReviewSecondary: 'approved',
      codeReviewPrimary: 'approved',
      codeReviewSecondary: ['changes_requested', 'changes_requested', 'changes_requested', 'changes_requested', 'approved'],
    },
    gate: (topic) => {
      if (topic !== 'plan') return { decision: 'approve' };
      planTopicGates++;
      if (planTopicGates === 1) return { decision: 'approve' };
      return { decision: 'reject', outcome: 'rework', note: 'Address the remaining review findings.' };
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(attemptCount(rec, 'developer'), 1);
  assert.equal(attemptCount(rec, 'reworkDeveloper'), 3);
  assert.equal(attemptCount(rec, 'stuckReworkDeveloper'), 1);
  assert.equal(attemptCount(rec, 'codeReviewPrimary'), 5);
  assert.equal(attemptCount(rec, 'codeReviewSecondary'), 5);
  assert.equal(rec.integrateCalls, 1, 'integrator runs only after the human-directed recovery passes consensus');
  assert.match(
    rec.integratorInputs[0]?.change?.headSha ?? '',
    /^sha-stuckReworkDeveloper-/,
    'integrator must receive the human-directed stuck rework head',
  );
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planGate', 'codeStuckGate', 'mergeGate']);
  assert.deepEqual(rec.outputs.find((output) => output.nodeId === 'codeStuckGate')?.payload, {
    outcome: 'rework',
    note: 'Address the remaining review findings.',
    resolvedBy: '',
    resolvedAt: '',
    inboxId: 'codeStuckGate',
    decision: 'reject',
  });
});

test('DD-default-codex: failed stuck rework routes to final stuck gate without another implicit rework', async () => {
  let planTopicGates = 0;
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: {
      planReviewPrimary: 'approved',
      planReviewSecondary: 'approved',
      codeReviewPrimary: 'approved',
      codeReviewSecondary: 'changes_requested',
    },
    gate: (topic) => {
      if (topic !== 'plan') return { decision: 'approve' };
      planTopicGates++;
      if (planTopicGates === 1) return { decision: 'approve' };
      if (planTopicGates === 2) return { decision: 'reject', outcome: 'rework', note: 'Try one bounded recovery.' };
      return { decision: 'reject', outcome: 'abort', note: 'Stop after failed recovery.' };
    },
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  assert.equal(attemptCount(rec, 'stuckReworkDeveloper'), 1);
  assert.equal(attemptCount(rec, 'codeReviewPrimary'), 8);
  assert.equal(attemptCount(rec, 'codeReviewSecondary'), 8);
  assert.equal(rec.integrateCalls, 0);
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planGate', 'codeStuckGate', 'codeStuckGate']);
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

test('DD2: reviewer BLOCKER ×cap opens codeStuckGate; cancel reaches cancelled terminal', async () => {
  const { run, rec } = buildAdapter({
    // codeReview always blocker -> codeReviewRouter loops to reworkDeveloper until codeReviewLoop caps, then
    // parks at the reusable codeStuckGate. Human cancel is an intentional cancelled terminal, not blocked.
    verdicts: { codeReview: 'blocker' },
    gate: (_topic, gateKey) => (gateKey.startsWith('codeStuckGate') ? { decision: 'reject', outcome: 'cancel' } : { decision: 'approve' }),
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'the run cancels only after the human chooses cancel at codeStuckGate');
  assert.equal(rec.completed.length, 0);
  assert.equal(rec.blocked.length, 0, 'cancel must not be recorded as blocked');
  assert.deepEqual(rec.cancelled, [{ source: 'data-driven-cancelled' }]);
  assert.deepEqual(rec.gateSummaries.map((summary) => summary.nodeId), ['planGate', 'codeStuckGate']);
  assert.equal(rec.integrateCalls, 0, 'the integrator never ran after the review-stuck gate');
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
        : { prNumber: 1, headSha: 'ci-fixed-head', evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.equal(rec.pollPrCalls, 4, 'polled for CI failure, then clean, then mergeReadiness, then mergeApproveReverify re-poll');
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
      return { prNumber: 1, headSha: 'post-triage-head', evidence: [`post-triage poll ${polls} clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
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
    'post-triage-head',
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
      return { prNumber: 1, headSha: 'post-ci-head', evidence: [`post-ci poll ${polls} clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
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
 * router routes on the FRESH verdict — clean→mergeGate, review_changes→triage, ci_changes
 * (<ciLoop)→ciRework, recheck→mergeReadiness. No runtime code changes; the routing lives entirely in the
 * template (§8).
 */
function featureDevelopmentPrReviewWithMergeRecheck(): Template {
  const t = featureDevelopmentPrReview();
  if (!t.verdicts.domain.includes('recheck')) t.verdicts.domain = [...t.verdicts.domain, 'recheck'];
  const mergeGate = t.nodes['mergeGate'];
  assert.equal(mergeGate?.kind, 'humanGate', 'fixture mergeGate is a humanGate');
  if (mergeGate.kind === 'humanGate') {
    mergeGate.outcomes = ['approved', 'recheck', 'cancel'];
    mergeGate.branches = [
      on(verdictEq('approved'), 'mergeApproveReverify'),
      on(verdictEq('recheck'), 'mergeRecheck'),
      on(verdictEq('cancel'), 'cancelledEnd'),
      otherwise('blockedEnd'),
    ];
  }
  t.nodes['mergeRecheck'] = node.script('mergeRecheck', 'script:pollPr', 'mergeRecheckRouter', {
    resultSchema: 'schema:prFeedback',
    onFailure: 'route',
    produces: { name: 'prFeedback' },
    catch: [
      { onError: 'revo.ScriptBlocked', goto: 'classifyRecovery' },
      { onError: 'revo.ScriptFailed', goto: 'classifyRecovery' },
    ],
  });
  t.nodes['mergeRecheckRouter'] = node.choice('mergeRecheckRouter', [
    on(verdictEq('clean'), 'mergeGate'),
    on(verdictEq('review_changes'), 'triage'),
    on(allOf(verdictEq('ci_changes'), counterLt('ciLoop', 3)), 'ciRework'),
    on(verdictEq('recheck'), 'mergeReadiness'),
    otherwise('recoveryGate'),
  ]);
  // Mirror the JSON catalogs: the recovery nodes also consume the FRESH mergeRecheck feedback (optional +
  // staleOk, since mergeRecheck only runs on the reject path) so a reject-routed triage/ciRework acts on the
  // re-poll evidence, not the stale pre-gate readiness.
  for (const nodeId of ['triage', 'ciRework']) {
    const recovery = t.nodes[nodeId];
    if (recovery.kind === 'agent' && !recovery.consumes?.some((consume) => consume.node === 'mergeRecheck' && consume.as === 'recheckFeedback')) {
      recovery.consumes = [
        ...(recovery.consumes ?? []),
        { node: 'mergeRecheck', as: 'recheckFeedback', optional: true, staleOk: true },
      ];
    }
  }
  return t;
}

test('DD-issue-276: merge recheck + a still-clean re-poll re-presents mergeGate, then cancel stops deliberately', async () => {
  let mergeSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReviewWithMergeRecheck(),
    verdicts: { codeReview: 'approved' },
    gate: (topic) => {
      if (topic !== 'merge') return { decision: 'approve' };
      mergeSeen++;
      return mergeSeen === 1 ? { outcome: 'recheck' } : { outcome: 'cancel' };
    },
  });

  const result = await run();

  assert.equal(result.status, 'cancelled', 'a still-clean re-poll re-presents mergeGate; cancel is the deliberate stop');
  assert.equal(rec.completed.length, 0, 'an aborted merge does not complete the run');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge never ran');
  assert.equal(rec.pollPrCalls, 3, 'pollPr → mergeReadiness → mergeRecheck (the reject re-polled fresh readiness)');
  assert.deepEqual(rec.gates, ['plan', 'merge', 'merge'], 'the merge gate opened again after the clean recheck');
  const [, reopenedMerge] = rec.gateSummaries.filter((summary) => summary.nodeId === 'mergeGate');
  assert.equal(reopenedMerge?.gatedArtifact?.nodeId, 'mergeRecheck', 'reopened merge gate surfaces the fresh recheck artifact');
});

test('DD-issue-276: named merge gate recheck outcome re-polls readiness and parks again', async () => {
  let mergeSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReviewWithMergeRecheck(),
    verdicts: { codeReview: 'approved' },
    gate: (topic) => {
      if (topic !== 'merge') return { outcome: 'approved' };
      mergeSeen++;
      return mergeSeen === 1 ? { outcome: 'recheck' } : { outcome: 'cancel' };
    },
  });

  const result = await run();

  assert.equal(result.status, 'cancelled', 'a clean named recheck parks at mergeGate again');
  assert.equal(rec.pollPrCalls, 3, 'pollPr -> mergeReadiness -> mergeRecheck');
  assert.equal(rec.confirmMergeCalls, 0);
  assert.deepEqual(rec.gates, ['plan', 'merge', 'merge']);
});

test('DD-issue-223: pollPr recheck verdict loops inside readiness polling', async () => {
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    pollPr: () => {
      polls++;
      if (polls === 1) {
        return { prNumber: 1, headSha: 'pending', evidence: ['provider pending'], verdict: 'recheck' as const, ciFailures: [], reviewThreads: [] };
      }
      return { prNumber: 1, headSha: 'clean-head', evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.equal(rec.pollPrCalls, 4, 'first pollPr recheck repeats pollPr, then mergeReadiness, then mergeApproveReverify re-poll');
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
      // recheck the FIRST merge gate (drives the re-poll reroute); approve the SECOND (after recovery).
      return mergeSeen === 1 ? { outcome: 'recheck' } : { decision: 'approve' };
    },
    pollPr: () => {
      polls++;
      // poll 1 = pollPr, poll 2 = mergeReadiness (both clean → reach the merge gate);
      // poll 3 = mergeRecheck after the recheck → review_changes (reroute to triage); then clean to recover.
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
      const headSha = polls < 3 ? 'pre-merge-head' : 'post-review-head';
      return { prNumber: 1, headSha, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
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
  const mergeSummaries = rec.gateSummaries.filter((summary) => summary.nodeId === 'mergeGate');
  assert.equal(mergeSummaries.length, 2, 'the run opened the initial merge gate and the recovered merge gate');
  assert.equal(
    mergeSummaries[1]?.gatedArtifact?.nodeId,
    'mergeReadiness',
    'the recovered merge gate surfaces current mergeReadiness, not the stale mergeRecheck artifact',
  );
  assert.equal(
    (mergeSummaries[1]?.gatedArtifact?.payload as { headSha?: string } | undefined)?.headSha,
    'post-review-head',
    'the recovered merge gate carries the latest clean readiness payload',
  );
});

test('DD-issue-223: merge reject + a recheck re-poll continues readiness polling, NOT blocked', async () => {
  // The merge gate opens after pollPr(clean)→mergeReadiness(clean). A human REJECT re-polls; if that fresh
  // result is still unsettled (recheck), the merge-recheck router must continue through mergeReadiness instead
  // of falling through to blockedEnd.
  let polls = 0;
  let mergeSeen = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReviewWithMergeRecheck(),
    verdicts: { codeReview: 'approved' },
    gate: (topic) => {
      if (topic !== 'merge') return { decision: 'approve' };
      mergeSeen++;
      return mergeSeen === 1 ? { outcome: 'recheck' } : { decision: 'approve' };
    },
    pollPr: () => {
      polls++;
      if (polls === 3) {
        return {
          prNumber: 1,
          headSha: 'recheck-pending',
          evidence: ['merge-recheck re-poll found pending readiness'],
          verdict: 'recheck' as const,
          ciFailures: [],
          reviewThreads: [],
        };
      }
      const headSha = polls < 3 ? 'pre-merge-head' : 'after-recheck-head';
      return { prNumber: 1, headSha, evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.equal(result.status, 'succeeded', 'the unsettled merge recheck loops through readiness polling, then merges');
  assert.equal(rec.blocked.length, 0, 'the recheck verdict did not terminal-block the run');
  assert.equal(rec.completed.length, 1, 'the run completes after the later merge approval');
  assert.equal(rec.pollPrCalls, 5, 'pollPr → mergeReadiness → mergeRecheck(recheck) → mergeReadiness(clean) → mergeApproveReverify');
  assert.equal(mergeSeen, 2, 'the merge gate re-opened after the extra readiness poll');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge only ran after the later merge approval');
  const mergeSummaries = rec.gateSummaries.filter((summary) => summary.nodeId === 'mergeGate');
  assert.equal(
    mergeSummaries[1]?.gatedArtifact?.nodeId,
    'mergeReadiness',
    'mergeRecheckRouter recheck→mergeReadiness→mergeGate surfaces mergeReadiness, not stale mergeRecheck',
  );
  assert.equal(
    (mergeSummaries[1]?.gatedArtifact?.payload as { headSha?: string } | undefined)?.headSha,
    'after-recheck-head',
    'the re-polled merge gate carries the mergeReadiness payload that immediately preceded it',
  );
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
    issueAction: 'refs',
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.worktreeIssueRefs, [issueRef]);
  assert.deepEqual(rec.capturedChanges[0]?.issueRef, issueRef);
  assert.equal(rec.capturedChanges[0]?.issueAction, 'refs');
  assert.deepEqual(rec.integratorInputs[0]?.issueRef, issueRef);
  assert.equal(rec.integratorInputs[0]?.issueAction, 'refs');
  assert.deepEqual(rec.integratorInputs[0]?.change?.issueRef, issueRef);
  assert.equal(rec.integratorInputs[0]?.change?.issueAction, 'refs');
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

test('DD4a-issue-140: produced change metadata reaches the live integrator without duplicate capture', async () => {
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
  assert.ok(rec.events.includes('worktree_create:pipeline'), 'script:integrator makes the run live even with script/stub agent producers');
});

test('DD4b: pollPr ci_changes forever → cap → recoveryGate → cancelled terminal (ciLoop is DATA)', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: () => ({ prNumber: 1, headSha: 's', evidence: ['build failed'], verdict: 'ci_changes' as const, ciFailures: [{ name: 'build', conclusion: 'FAILURE' }], reviewThreads: [] }),
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'ciLoop exhaustion routes to recoveryGate; cancel outcome → cancelled terminal');
  assert.equal(rec.cancelled.length, 1);
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
        : { prNumber: 1, headSha: 'review-fixed-head', evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
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

test('DD4d: pollPr review_changes → triage(question) → questionGate(wontfix) → respondThreads → pollPr(clean) → mergeReadiness(clean)', async () => {
  const note = 'the requested rewrite is out of scope for this run';
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', triage: 'question' },
    gate: (topic) => topic === 'question' ? { outcome: 'wontfix', note } : { decision: 'approve' },
    respondThreads: (input) => {
      assert.deepEqual(input.gateResolution, {
        outcome: 'wontfix',
        note,
        resolvedBy: '',
        resolvedAt: '',
        inboxId: 'questionGate',
      });
      return { replied: 1, resolved: 1 };
    },
    pollPr: (() => {
      let polls = 0;
      return () => {
        polls++;
        return polls === 1
          ? { prNumber: 1, headSha: 's1', evidence: ['poll 1: review thread T1'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'why?' }] }
          : { prNumber: 1, headSha: 'wontfix-clean-head', evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
      };
    })(),
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates.slice(0, 3), ['plan', 'question', 'merge']);
  assert.equal(rec.respondCalls, 1, 'wontfix path replies + resolves via respondThreads');
  assert.equal(rec.integrateCalls, 1, 'wontfix needs no re-push (integrator ran only for the initial PR)');
});

test('DD4e: questionGate(fix) sends the human note to question rework without leaking into later triage fix', async () => {
  const note = 'human confirms this review question is a real defect';
  let polls = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', triage: ['question', 'fix'] },
    gate: (topic) => topic === 'question' ? { outcome: 'fix', note } : { decision: 'approve' },
    pollPr: () => {
      polls++;
      if (polls === 1) {
        return { prNumber: 1, headSha: 's1', evidence: ['poll 1: review thread T1 asks a question'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T1', body: 'is this intended?' }] };
      }
      if (polls === 2) {
        return { prNumber: 1, headSha: 's2', evidence: ['poll 2: review thread T2 needs a direct fix'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [{ threadId: 'T2', body: 'fix this too' }] };
      }
      return { prNumber: 1, headSha: 'question-fixed-head', evidence: [`poll ${polls}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.inputsByStep['questionReviewRework'], {
    triage: { from: 'triage' },
    gateResolution: {
      outcome: 'fix',
      note,
      resolvedBy: '',
      resolvedAt: '',
      inboxId: 'questionGate',
    },
  });
  assert.deepEqual(rec.inputsByStep['reviewRework'], {
    triage: { from: 'triage' },
  });
  assert.match(
    rec.integratorInputs[1]?.change?.headSha ?? '',
    /^sha-questionReviewRework-/,
    'questionReviewIntegrator consumes the questionReviewRework produced head',
  );
  assert.match(
    rec.integratorInputs[2]?.change?.headSha ?? '',
    /^sha-reviewRework-/,
    'reviewIntegrator still consumes the regular reviewRework produced head',
  );
  assert.equal(rec.respondCalls, 2);
});

test('DD5: a DELIBERATE agent needsHuman opens a question and retries with the answer', async () => {
  const answer = { provider: 'oauth' };
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-resume'),
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'parked' },
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic) => (topic === 'question'
      ? { answer, resolvedBy: 'human', inboxId: 'inbox-question' }
      : { decision: 'approve' }),
  });
  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1], ['developer#2', 1]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[0]?.input as { retryContext?: unknown }).retryContext, undefined);
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: unknown }).retryContext, {
    kind: 'agent_question',
    nodeId: 'developer',
    answer,
    lesson: 'parked',
    inboxId: 'inbox-question',
    resolvedBy: 'human',
  });
  assert.ok(rec.events.includes('agent_question_resolved:developer'));
});

test('DD5: an agent question accepts resolution metadata nested in the answer', async () => {
  const actualAnswer = { provider: 'oauth' };
  const answer = { ...actualAnswer, resolvedBy: 'human', inboxId: 'inbox-question' };
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-nested-resolution'),
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which provider?' },
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic) => (topic === 'question'
      ? { answer }
      : { decision: 'approve' }),
  });
  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1], ['developer#2', 1]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[0]?.input as { retryContext?: unknown }).retryContext, undefined);
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: unknown }).retryContext, {
    kind: 'agent_question',
    nodeId: 'developer',
    answer,
    lesson: 'which provider?',
    inboxId: 'inbox-question',
    resolvedBy: 'human',
  });
  assert.ok(rec.events.includes('agent_question_resolved:developer'));
});

test('DD5: an unresolved agent question blocks without retryContext or resolved event', async () => {
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-timeout'),
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which provider?' },
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic) => (topic === 'question'
      ? { decision: 'reject', answer: { reason: 'gate-timeout' }, inboxId: 'inbox-question-timeout' }
      : { decision: 'approve' }),
  });
  const result = await run();

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked.length, 1);
  assert.equal(rec.blocked[0]?.reason, 'agent-question-unresolved');
  assert.equal(rec.failed.length, 0);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.equal(developerInputs.length, 1);
  assert.deepEqual((developerInputs[0]?.input as { retryContext?: unknown }).retryContext, undefined);
  assert.equal(rec.events.includes('agent_question_resolved:developer'), false);
  assert.equal(rec.outputs.length, 0);
});

test('DD5: an answered agent question retries even when transient maxAttempts is 1', async () => {
  const answer = { provider: 'oauth' };
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-single-attempt'),
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which provider?' },
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic) => (topic === 'question'
      ? { answer, resolvedBy: 'human', inboxId: 'inbox-question-1' }
      : { decision: 'approve' }),
  });
  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1], ['developer#2', 1]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: unknown }).retryContext, {
    kind: 'agent_question',
    nodeId: 'developer',
    answer,
    lesson: 'which provider?',
    inboxId: 'inbox-question-1',
    resolvedBy: 'human',
  });
});

test('DD5: repeated agent questions use fresh inbox keys and sequential retry contexts', async () => {
  const firstAnswer = { provider: 'oauth' };
  const secondAnswer = { region: 'eu' };
  const questionAnswers = [firstAnswer, secondAnswer];
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-repeated'),
    retryPolicy: { maxAttempts: 1, backoffMs: 0 },
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which provider?' },
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which region?' },
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic, gateKey) => {
      if (topic !== 'question') return { decision: 'approve' };
      const answer = questionAnswers.shift();
      assert.ok(answer, `unexpected question gate ${gateKey}`);
      return { answer, resolvedBy: 'human', inboxId: `inbox-${gateKey}` };
    },
  });
  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question', 'question']);
  assert.equal(new Set(rec.gateKeys).size, 2);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1], ['developer#2', 1], ['developer#3', 1]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: unknown }).retryContext, {
    kind: 'agent_question',
    nodeId: 'developer',
    answer: firstAnswer,
    lesson: 'which provider?',
    inboxId: `inbox-${rec.gateKeys[0]}`,
    resolvedBy: 'human',
  });
  assert.deepEqual((developerInputs[2]?.input as { retryContext?: unknown }).retryContext, {
    kind: 'agent_question',
    nodeId: 'developer',
    answer: secondAnswer,
    lesson: 'which region?',
    inboxId: `inbox-${rec.gateKeys[1]}`,
    resolvedBy: 'human',
  });
});

test('DD5: question retryContext survives a transient retry on the reopened node', async () => {
  const answer = { provider: 'oauth' };
  const retryContext = {
    kind: 'agent_question',
    nodeId: 'developer',
    answer,
    lesson: 'which provider?',
    inboxId: 'inbox-question-transient',
    resolvedBy: 'human',
  };
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('agent-question-transient-retry'),
    retryPolicy: { maxAttempts: 2, backoffMs: 0 },
    results: {
      developer: [
        { output: { from: 'developer' }, verdict: 'blocker', nextSteps: [], costs: [], needsHuman: true, lesson: 'which provider?' },
        runnerFailedResult('runner process timed out'),
        { output: { from: 'developer', ok: true }, verdict: 'approved', nextSteps: [], costs: [], needsHuman: false },
      ],
    },
    gate: (topic) => (topic === 'question'
      ? { answer, resolvedBy: 'human', inboxId: retryContext.inboxId }
      : { decision: 'approve' }),
  });
  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question']);
  assert.deepEqual(
    rec.runStepAttempts.filter((attempt) => baseStepKey(attempt.stepKey) === 'developer').map((attempt) => [attempt.stepKey, attempt.attemptNo]),
    [['developer', 1], ['developer#2', 1], ['developer#2', 2]],
  );
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[0]?.input as { retryContext?: unknown }).retryContext, undefined);
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: unknown }).retryContext, retryContext);
  assert.deepEqual((developerInputs[2]?.input as { retryContext?: unknown }).retryContext, retryContext);
  assert.ok(rec.events.includes('runner_retry_scheduled:developer#2'));
  assert.equal(rec.events.includes('runner_retry_exhausted:developer#2'), false);
  assert.equal(rec.blocked.length, 0);
  assert.equal(rec.failed.length, 0);
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

test('DD5-retry-gate: exhausted transient runner failure can be retried by a human gate in the same run', async () => {
  const tmpl = singleDeveloperTemplate('manual-retry-success');
  const { run, rec } = buildAdapter({
    template: tmpl,
    gate: (topic) => (topic === 'retry' ? { outcome: 'retry', answer: { outcome: 'retry', reconcile: 'keep' } } : { decision: 'approve' }),
    results: {
      developer: [
        runnerFailedResult('runner process timed out'),
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
  const attempts = rec.runStepAttempts.filter((a) => baseStepKey(a.stepKey) === 'developer');
  const retrySummary = rec.gateSummaries.find((summary) => (summary as Record<string, unknown>).kind === 'transient_retry') as Record<string, unknown> | undefined;

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['retry']);
  assert.equal(retrySummary?.nodeId, 'developer');
  assert.equal(retrySummary?.reason, 'runner-transient-failure:timeout');
  assert.deepEqual(
    attempts.map((a) => ({ stepKey: a.stepKey, attemptNo: a.attemptNo })),
    [
      { stepKey: 'developer', attemptNo: 1 },
      { stepKey: 'developer', attemptNo: 2 },
      { stepKey: 'developer#2', attemptNo: 1 },
    ],
  );
  assert.equal(rec.outputs[0]?.attemptId, attempts[2]?.attemptId, 'the post-gate retry stores the winning fresh attempt');
  assert.equal(rec.blocked.length, 0);
  assert.ok(rec.events.includes('runner_retry_exhausted:developer'), 'the exhausted path is durable before the gate opens');
});

test('DD5-retry-gate: give_up preserves the terminal blocked behavior after exhausted transient retries', async () => {
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('manual-retry-give-up'),
    gate: (topic) => (topic === 'retry' ? { outcome: 'give_up', answer: { outcome: 'give_up', note: 'stop here' } } : { decision: 'approve' }),
    results: {
      developer: runnerFailedResult('runner process timed out'),
    },
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['retry']);
  assert.equal(rec.blocked[0]?.reason, 'runner-transient-failure:timeout');
  assert.deepEqual(
    rec.runStepAttempts.filter((a) => a.stepKey === 'developer').map((a) => a.attemptNo),
    [1, 2],
  );
  assert.equal(rec.events.includes('runner_retry_exhausted:developer'), true);
});

test('DD5-retry-gate: retry after exhaustion can exhaust again into a distinct second retry gate', async () => {
  let retryGateCount = 0;
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('manual-retry-second-exhaustion'),
    gate: (topic) => {
      if (topic !== 'retry') return { decision: 'approve' };
      retryGateCount++;
      return retryGateCount === 1
        ? { outcome: 'retry', answer: { outcome: 'retry', reconcile: 'keep' } }
        : { outcome: 'give_up', answer: { outcome: 'give_up' } };
    },
    results: {
      developer: [
        runnerFailedResult('runner process timed out'),
        runnerFailedResult('runner process timed out'),
        runnerFailedResult('runner process timed out'),
        runnerFailedResult('runner process timed out'),
      ],
    },
  });

  const result = await run();
  const attempts = rec.runStepAttempts.filter((a) => baseStepKey(a.stepKey) === 'developer');

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['retry', 'retry']);
  assert.deepEqual(rec.gateKeys, ['transientRetry:developer', 'transientRetry:developer#2']);
  assert.deepEqual(
    attempts.map((a) => ({ stepKey: a.stepKey, attemptNo: a.attemptNo })),
    [
      { stepKey: 'developer', attemptNo: 1 },
      { stepKey: 'developer', attemptNo: 2 },
      { stepKey: 'developer#2', attemptNo: 1 },
      { stepKey: 'developer#2', attemptNo: 2 },
    ],
  );
  assert.ok(rec.events.includes('runner_retry_exhausted:developer'));
  assert.ok(rec.events.includes('runner_retry_exhausted:developer#2'));
});

test('DD5-transient-classifier: provider 529 / Overloaded failures exhaust into the retry gate', async () => {
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('manual-retry-529'),
    gate: (topic) => (topic === 'retry' ? { outcome: 'give_up', answer: { outcome: 'give_up' } } : { decision: 'approve' }),
    results: {
      developer: runnerFailedResult('provider 529 Overloaded; please retry later'),
    },
  });

  const result = await run();
  const retrySummary = rec.gateSummaries.find((summary) => (summary as Record<string, unknown>).kind === 'transient_retry') as Record<string, unknown> | undefined;

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['retry']);
  assert.equal(rec.blocked[0]?.reason, 'runner-transient-failure:overloaded');
  assert.equal(retrySummary?.transientKind, 'overloaded');
  assert.equal(retrySummary?.reason, 'runner-transient-failure:overloaded');
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
  const stepFailed = rec.eventRecords.find((event) => event.type === 'step_failed' && event.stepKey === 'review');
  assert.match(JSON.stringify(stepFailed?.payload ?? {}), /revo\.ResultInvalid/);
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

function blockedScriptAfterFailureTemplate(): Template {
  return template('blocked-script-after-failure')
    .title('blocked script after explicit failure')
    .entry('firstScript')
    .domain('approved')
    .add(
      node.script('firstScript', 'script:integrator', 'unexpectedSuccess', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptFailed', goto: 'blockedScript' }],
      }),
      node.script('blockedScript', 'script:integrator', 'unexpectedSuccess', {
        resultSchema: 'schema:integration',
        onFailure: 'route',
        catch: [{ onError: 'revo.ScriptBlocked', goto: 'failedEnd' }],
      }),
      node.terminal('unexpectedSuccess', 'succeeded'),
      node.terminal('failedEnd', 'failed'),
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
  assert.match(rec.failed[0] ?? '', /revo\.ScriptFailed: git push rejected: non-fast-forward/);
  assert.equal(rec.blocked.length, 0);
});

test('blocked script failure does not reuse a previous explicit script failure reason', async () => {
  let calls = 0;
  const { run, rec } = buildAdapter({
    template: blockedScriptAfterFailureTemplate(),
    integrate: () => {
      calls++;
      if (calls === 1) throw new Error('first explicit script failure');
      return { needsHuman: true, lesson: 'blocked without explicit failure reason' };
    },
  });

  const result = await run();

  assert.equal(result.status, 'failed');
  assert.equal(calls, 2);
  assert.equal(rec.failed.length, 1);
  assert.equal(rec.failed[0], 'data-driven pipeline reached a failed terminal (lastVerdict=blocked)');
  assert.doesNotMatch(rec.failed[0] ?? '', /first explicit script failure/);
});

test('verification environment needsHuman opens recovery gate and records non-adoption decision', async () => {
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('verification-recovery-env'),
    results: {
      developer: {
        output: { from: 'developer', reason: 'verification failed: sandbox denied loopback socket listen' },
        verdict: 'blocker',
        nextSteps: [],
        costs: [],
        needsHuman: true,
        lesson: 'pnpm verify blocked by sandbox permission: listen EACCES on loopback socket',
        artifacts: { process: { ref: 'attempt:attempt-1' } },
      },
    },
    gate: () => ({ outcome: 'continue_in_revo' }),
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked[0]?.reason, 'verification-recovery-decision:continue_in_revo');
  const summary = rec.gateSummaries[0] as Record<string, unknown>;
  assert.equal(summary['topic'], 'verification_recovery');
  assert.equal(summary['runId'], RUN_ID);
  assert.equal(summary['step'], 'developer');
  assert.equal(summary['role'], 'developer');
  assert.equal(summary['artifactRef'], 'attempt:attempt-1');
  assert.deepEqual(summary['outcomes'], ['rerun_with_permissions', 'continue_in_revo', 'adopt_patch_manually', 'abort']);
  assert.match(String(summary['policy']), /must not apply, copy, cherry-pick, stage, commit, or push/);
});

test('runner_failed verification environment block opens recovery gate before transient routing', async () => {
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('verification-recovery-runner-failed-env'),
    results: {
      developer: runnerFailedResult(
        'pnpm verify failed: EPERM open /Users/anton/.revo/host.json; EPERM listen 127.0.0.1',
        { artifactRef: 'attempt:attempt-1' },
      ),
    },
    gate: () => ({ outcome: 'continue_in_revo' }),
  });

  const result = await run();

  assert.equal(result.status, 'blocked');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal(rec.blocked[0]?.reason, 'verification-recovery-decision:continue_in_revo');
  assert.equal(rec.events.includes('runner_retry_scheduled:developer'), false);
  assert.equal(rec.events.includes('runner_retry_exhausted:developer'), false);
  const summary = rec.gateSummaries[0] as Record<string, unknown>;
  assert.equal(summary['topic'], 'verification_recovery');
  assert.equal(summary['reason'], 'verification-environment-blocked');
});

test('code verification needsHuman opens an agent question, not an environment recovery gate', async () => {
  const answer = { decision: 'fix the test failure' };
  const { run, rec } = buildAdapter({
    template: singleDeveloperTemplate('verification-recovery-code'),
    results: {
      developer: [
        {
          output: { from: 'developer', reason: 'verification failed: expected 1 got 2' },
          verdict: 'blocker',
          nextSteps: [],
          costs: [],
          needsHuman: true,
          lesson: 'pnpm test failed: assertion expected 1 got 2',
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
    gate: (topic) => (topic === 'question'
      ? { answer, resolvedBy: 'human', inboxId: 'inbox-code-question' }
      : { decision: 'approve' }),
  });

  const result = await run();

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(rec.gates, ['question']);
  assert.equal((rec.gateSummaries[0] as Record<string, unknown>)['kind'], 'agent_question');
  assert.notEqual((rec.gateSummaries[0] as Record<string, unknown>)['topic'], 'verification_recovery');
  const developerInputs = rec.stepInputs.filter((item) => baseStepKey(item.stepKey) === 'developer');
  assert.deepEqual((developerInputs[1]?.input as { retryContext?: { answer?: unknown } }).retryContext?.answer, answer);
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
  assert.deepEqual(rec.gates, [], 'revo.InputMissing is terminal and does not open a retry gate');
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

// ─── engine no longer auto-deletes on failure (issue #208) ───────────────────

test('failed run: engine does NOT fire worktree_release (teardown is opt-in pipeline step)', async () => {
  // featureDevelopment has no cleanupWorktree node; integrator failing routes to failedEnd.
  const { run, rec } = buildAdapter({
    template: featureDevelopment(),
    integrate: () => { throw new Error('network error'); },
  });
  const r = await run();
  assert.equal(r.status, 'failed');
  assert.ok(rec.events.includes('worktree_create:pipeline'), 'worktree created');
  assert.ok(!rec.events.includes('worktree_release:pipeline'), 'worktree NOT released on failure — preserved for inspection');
});

test('plain featureDevelopment (no cleanupWorktree) succeeded run does NOT release worktree', async () => {
  // mergeGate -> mergedEnd: no cleanupWorktree node, so release must never fire.
  const { run, rec } = buildAdapter({ template: featureDevelopment(), verdicts: { watcherPost: 'clean' } });
  const r = await run();
  assert.equal(r.status, 'succeeded');
  assert.ok(rec.events.includes('worktree_create:pipeline'));
  assert.ok(!rec.events.includes('worktree_release:pipeline'), 'no release without an explicit cleanupWorktree node');
});

function makeMinimalDeps(): DataDrivenTaskDeps {
  return {
    appendEvent: async () => {},
    appendRunOutput: async () => {},
    setProgress: async () => {},
    sleep: async () => {},
    awaitHuman: async () => ({ decision: 'approve' as const }),
    completeRun: async () => null,
    failRun: async () => null,
    blockRun: async () => null,
    cancelRun: async () => null,
    loadRunTaskContext: async () => ({ taskId: 'task-1', title: 'T', base: 'master', repoRef: '', issueRef: undefined, issueAction: undefined }),
    integrateFn: async (input) => ({ prUrl: `stub://pr/${input.taskId}`, branch: 'feat/x', prNumber: 1 }),
    preflightFn: async () => ({ ok: true }),
    createWorktreeFn: async () => ({ worktreePath: '/fake/worktree' }),
    releaseWorktreeFn: async () => ({ released: true, worktreePath: '/fake/worktree' }),
    confirmMergeFn: async (input) => ({ merged: true as const, prNumber: 1, prUrl: `stub://pr/${input.taskId}` }),
    overrideMergeFn: async (input) => ({
      prNumber: 1,
      headSha: 'sha',
      evidence: [`overrideMerge ${input.taskId}: clean`],
      verdict: 'clean' as const,
      ciFailures: [],
      reviewThreads: [],
      override: { accepted: true, actor: 'test', note: 'test override', source: { gate: 'mergeGate', inboxId: 'inbox-test' }, facts: [], replied: 0, resolved: 0 },
    }),
    pollPrFn: async () => ({ prNumber: 1, headSha: 'sha', evidence: [], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] }),
    respondThreadsFn: async () => ({ replied: 0, resolved: 0 }),
    captureChangeFn: async (input) => ({ branch: `feat/${input.taskId}`, headSha: 'sha', worktreePath: '/fake/worktree' }),
  };
}

test('dispatch: runStepFn receives the exact pinned model binding for each agent node', async () => {
  const capturedBindings = new Map<string, ResolvedAgentBinding>();
  const runStepFn = async (
    _runId: string,
    _role: string,
    stepKey: string,
    _input: unknown,
    binding: ResolvedAgentBinding,
    _physicalAttempt?: { attemptNo: number; attemptId: string },
    _acceptedVerdicts?: readonly string[],
  ): Promise<AttemptResult> => {
    capturedBindings.set(stepKey, binding);
    return { output: { from: stepKey }, verdict: 'approved', nextSteps: [], costs: [] };
  };

  const fn = makeDataDrivenTask(runStepFn, makeMinimalDeps());
  await fn(RUN_ID, {
    route: exactRouteForTemplate(localChange()),
    runnerRetryPolicy: resolveRunnerTransientRetryPolicy(),
  });

  const developerBinding = capturedBindings.get('developer');
  assert.ok(developerBinding);
  assert.equal(developerBinding.runnerId, 'codex');
  assert.equal(developerBinding.provider, 'openai');
  assert.equal(developerBinding.modelId, 'gpt-5.6-luna');
  assert.deepEqual(developerBinding.modelParams, {});
  assert.equal(developerBinding.permissionMode, 'workspace-write');
  assert.equal(developerBinding.slotKey, 'node:developer');
});

// ─── reverify-path tests: AC#2 (stale/unmergeable at mergeApproveReverify → recovery) ───────────

test('DD-reverify-a: blocked at mergeApproveReverify → catch → classifyRecovery → recoveryGate → cancel (AC#2 catch path)', async () => {
  // pollPr calls 1+2 = pollPr + mergeReadiness (clean, pre-gate); call 3 = mergeApproveReverify (blocked).
  // Blocked returns {needsHuman} → errorCode revo.ScriptBlocked → catch → classifyRecovery.
  // classifyRecovery returns default (not 'fix') → recoveryRouter default → recoveryGate opens.
  // Gate decider cancels recoveryGate → cancelled terminal, confirmMerge never called.
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 3) return { needsHuman: true as const, lesson: 'PR is stale (DIRTY) after approval' };
      return { prNumber: 1, headSha: `sha-${pollCount}`, evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'blocked at reverify routes to recoveryGate → cancel → cancelled');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge must not be called when reverify blocks');
  assert.ok(rec.gates.includes('merge'), 'recoveryGate (topic merge) must open');
  const recoverySummary = rec.gateSummaries.find((summary) => summary.nodeId === 'recoveryGate');
  assert.equal(recoverySummary?.gatedArtifact?.nodeId, 'mergeApproveReverify');
  assert.deepEqual(recoverySummary?.gatedArtifact?.payload, {
    reason: 'poll-pr',
    lesson: 'PR is stale (DIRTY) after approval',
    nodeId: 'mergeApproveReverify',
  });
});

test('DD-recovery: confirmMerge block without produces still reaches recoveryGate summary', async () => {
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    confirmMerge: () => ({ needsHuman: true as const, lesson: 'failed to mark PR #7 ready for review' }),
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge ran once');
  const recoverySummary = rec.gateSummaries.find((summary) => summary.nodeId === 'recoveryGate');
  assert.equal(recoverySummary?.gatedArtifact?.nodeId, 'confirmMerge');
  assert.deepEqual(recoverySummary?.gatedArtifact?.payload, {
    reason: 'confirm-merge',
    lesson: 'failed to mark PR #7 ready for review',
    nodeId: 'confirmMerge',
  });
  assert.ok(
    rec.outputs.some((output) => output.nodeId === 'confirmMerge' && output.name === 'recoveryContext'),
    'blocked script recovery context is persisted even when the node has no produces declaration',
  );
});

test('DD-recovery: successful recovery loop clears stale blocked script context before later recoveryGate', async () => {
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved', classifyRecovery: ['fix', 'other'] },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 3) return { needsHuman: true as const, lesson: 'PR is stale (DIRTY) after approval' };
      if (pollCount === 4) {
        return {
          prNumber: 1,
          headSha: 'sha-review',
          evidence: ['review changes after recovery'],
          verdict: 'review_changes' as const,
          ciFailures: [],
          reviewThreads: [],
        };
      }
      return { prNumber: 1, headSha: `sha-${pollCount}`, evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });

  const result = await run();

  assert.equal(result.status, 'cancelled');
  const recoveryGate = featureDevelopmentPrReview().nodes['recoveryGate'];
  assert.equal(
    recoveryGate.kind === 'humanGate' ? recoveryGate.gatedArtifact?.node : undefined,
    'pollPr',
    'after recoveryContext is cleared, recoveryGate falls back to its configured pollPr artifact',
  );
  const recoverySummary = rec.gateSummaries.findLast((summary) => summary.nodeId === 'recoveryGate');
  assert.equal(recoverySummary?.gatedArtifact?.nodeId, 'pollPr');
  assert.equal((recoverySummary?.gatedArtifact?.payload as { verdict?: unknown } | undefined)?.verdict, 'review_changes');
});

test('DD-reverify-b: review_changes at mergeApproveReverify → router default → classifyRecovery → recoveryGate → cancel (AC#2 router path)', async () => {
  // pollPr call 3 = mergeApproveReverify returns review_changes → mergeApproveReverifyRouter default →
  // classifyRecovery → recoveryRouter default → recoveryGate → cancel → cancelled.
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 3) return { prNumber: 1, headSha: 'sha-3', evidence: ['pr has review comments'], verdict: 'review_changes' as const, ciFailures: [], reviewThreads: [] };
      return { prNumber: 1, headSha: `sha-${pollCount}`, evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'review_changes at reverify routes to classifyRecovery → recoveryGate → cancelled');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge must not be called when reverify returns review_changes');
  assert.ok(rec.gates.includes('merge'), 'recoveryGate opens');
});

test('DD-reverify-c: pollPr UNKNOWN recheck → second poll CLEAN → merges (AC#3 bounded recheck then merge)', async () => {
  // pollPr call 1 returns recheck (UNKNOWN); prRouter.recheck self-loops; call 2 returns clean.
  // Proceeds to mergeReadiness (call 3 clean) → mergeGate → mergeApproveReverify (call 4 clean) → merge.
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: () => ({ decision: 'approve' }),
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 1) return { prNumber: 1, headSha: 'sha-1', evidence: ['unsettled: UNKNOWN'], verdict: 'recheck' as const, ciFailures: [], reviewThreads: [] };
      return { prNumber: 1, headSha: 'stable-clean-head', evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'succeeded', 'bounded recheck then CLEAN → merges to succeeded');
  assert.equal(rec.confirmMergeCalls, 1, 'confirmMerge called once after CLEAN');
  assert.ok(pollCount >= 2, 'at least one recheck self-loop occurred');
});

test('DD-reverify-d: pollPr UNKNOWN recheck → blocked at reverify → recoveryGate → cancel (AC#3 no-merge)', async () => {
  // Call 1: recheck (UNKNOWN). Call 2: clean (pollPr again after recheck self-loop). Call 3: clean
  // (mergeReadiness). mergeGate approved. Call 4: blocked at mergeApproveReverify → classifyRecovery →
  // recoveryGate → cancel → cancelled, NOT terminal blocked.
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: featureDevelopmentPrReview(),
    verdicts: { codeReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 1) return { prNumber: 1, headSha: 'sha-1', evidence: ['unsettled: UNKNOWN'], verdict: 'recheck' as const, ciFailures: [], reviewThreads: [] };
      if (pollCount === 4) return { needsHuman: true as const, lesson: 'DIRTY at reverify after UNKNOWN recheck' };
      return { prNumber: 1, headSha: `sha-${pollCount}`, evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'UNKNOWN→recheck then blocked at reverify → recoveryGate cancel → cancelled (not terminal blocked)');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge must not be called');
});

test('DD-reverify-profile-consensus: blocked at mergeApproveReverify → recoveryGate on materialized consensus graph', async () => {
  // Same as DD-reverify-a but on the real materialized consensus template to verify the
  // parallel/join edges also route correctly through the recovery path.
  let pollCount = 0;
  const { run, rec } = buildAdapter({
    template: defaultConsensusProfileTemplate(),
    verdicts: { codeReview: 'approved', planReview: 'approved' },
    gate: (_topic, gateKey) => gateKey.startsWith('recoveryGate') ? { outcome: 'cancel' } : { decision: 'approve' },
    pollPr: (): PrFeedback | IntegratorBlocked => {
      pollCount++;
      if (pollCount === 3) return { needsHuman: true as const, lesson: 'stale at reverify on codex graph' };
      return { prNumber: 1, headSha: `sha-${pollCount}`, evidence: [`poll ${pollCount}: clean`], verdict: 'clean' as const, ciFailures: [], reviewThreads: [] };
    },
  });
  const result = await run();
  assert.equal(result.status, 'cancelled', 'consensus graph: blocked at reverify -> recoveryGate cancel -> cancelled');
  assert.equal(rec.confirmMergeCalls, 0, 'confirmMerge must not be called on consensus graph');
  assert.ok(rec.gates.includes('merge'), 'recoveryGate opens on consensus graph');
});
