import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import { taskBranchPrefix } from '../../runners/integrator-branch-naming.js';
import { worktreePathFor } from '../../control-plane/resolve-cwd.js';
import { getConfig } from '../../config.js';
import type { AgentSpec } from './agents.js';
import type { IntegratorOutcome } from './fake-integrator.js';
import type { GhScenario } from './gh-emulator.js';
import { caseGhCallBoundary, reviewReplyBodiesSince } from './gh-call-log.js';
import { createTargetRepo, type TargetRepo } from './git-target-repo.js';
import { createHostFixture, type HostFixture } from './harness.js';
import { waitForRunEvents } from './persisted-facts.js';
import { waitForExpectedGate, waitState } from './drive.js';
import { DEFAULT_PLAYBOOK_ID, PLAYBOOK_ID, givenInstalledPlaybook } from './scenarios.js';
import {
  stubDefaultAgentProfile,
  stubDefaultFullProfile,
  stubFixtureAgentProfile,
  stubFixtureFullProfile,
  stubFixtureIntegratorProfile,
  type E2eRunProfile,
} from './run-profiles.js';
import {
  materializedCoverageIdentity,
  validatePipelineCaseAttachment,
  type PipelineCaseAttachment,
} from '../../testing/policy/pipeline-coverage.js';

type GateTopic = 'plan' | 'merge' | 'question' | 'retry';
type GateStepContext = Readonly<{
  topic: GateTopic;
  options: readonly string[];
  nodeId?: string;
  summaryIncludes?: readonly string[];
  artifactHeadSha?: string;
  requirePlanArtifact?: boolean;
  pendingRisk?: Readonly<{ topic: string; kind: string }>;
}>;
type GateResolutionStep = GateStepContext & Readonly<{
  outcome: string;
  action?: never;
  reconcile?: 'keep';
  note?: string;
  mergeOverrideAudit?: Record<string, unknown>;
}>;
type GateActionStep = GateStepContext & Readonly<{
  action: 'reject' | 'cancel-run';
  outcome?: never;
}>;
type GateStep =
  | Readonly<{
      topic: 'question';
      answer: unknown;
      summaryIncludes?: readonly string[];
    }>
  | GateResolutionStep
  | GateActionStep;

type EventPathItem = string | { type: string; payload?: Record<string, unknown> };
type PipelineSideEffect =
  | 'create_pull_request'
  | 'merge_pull_request'
  | 'list_open_pull_requests'
  | 'list_all_pull_requests';

type ScenarioExpect = {
  readonly terminal: string;
  readonly engine?: string;
  readonly events?: readonly string[];
  readonly noEvents?: readonly string[];
  readonly path?: readonly EventPathItem[];
  readonly blockedDecision?: Readonly<{
    reason?: string;
    lessonIncludes?: readonly string[];
  }>;
  readonly failureReasonIncludes?: readonly string[];
  readonly sideEffects?: readonly PipelineSideEffect[];
  readonly forbiddenSideEffects?: readonly PipelineSideEffect[];
  readonly agentCalled?: readonly string[];
  readonly agentNodeCalled?: readonly string[];
  readonly agentCallCount?: Readonly<Record<string, number>>;
  readonly agentCallMinimum?: Readonly<Record<string, number>>;
  readonly sameWorktreeForAgent?: readonly string[];
  readonly agentRetryContexts?: ReadonlyArray<Readonly<{
    role: string;
    callIndex: number;
    kind: string;
    nodeId: string;
    answer: unknown;
    lesson: string;
    resolvedBy: string;
    distinctInboxFromCallIndex?: number;
  }>>;
  readonly agentContextIncludes?: Readonly<Record<string, readonly string[]>>;
  readonly agentAfterEvent?: ReadonlyArray<Readonly<{ role: string; event: string }>>;
  readonly reviewerConsensus?: Readonly<{
    nodeIds: readonly string[];
    verdicts: readonly string[];
    attemptVerdicts?: readonly string[];
    requireProcessArtifacts?: boolean;
  }>;
  readonly persistedDataExcludes?: readonly string[];
  readonly reviewReplyIncludes?: readonly string[];
};

const PIPELINE_TARGET = Symbol('pipeline-target');

export type PipelineTarget = Readonly<{ [PIPELINE_TARGET]: true }>;
export type PipelineAgentPlan = AgentSpec;
export type PipelineProfile =
  | 'default-agent'
  | 'default-full'
  | 'fixture-agent'
  | 'fixture-full'
  | 'fixture-integrator';

const targetRepos = new WeakMap<PipelineTarget, TargetRepo>();

function pipelineTarget(repo: TargetRepo): PipelineTarget {
  const target = Object.freeze({ [PIPELINE_TARGET]: true }) as PipelineTarget;
  targetRepos.set(target, repo);
  return target;
}

export type ScenarioRepo = 'workspace' | PipelineTarget;

const NO_EVENT_SETTLE_MS = 1_000;
const NO_EVENT_POLL_MS = 100;

type StartedPipelineCase = {
  runId: string;
  taskId: string;
  ghCallBoundary: number;
  title: string;
  coverage: PipelineCaseAttachment;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: string;
  cleanup?: { releaseWorktreeFails?: boolean; dirtyWorktreeBeforeRelease?: boolean };
};

export type PipelineCasePlan = {
  readonly title: string;
  readonly description?: string;
  readonly scope?: string;
  readonly repo: ScenarioRepo;
  readonly playbook?: 'fixture' | 'default';
  readonly playbookId?: string;
  readonly pipelineId?: string;
  readonly profile?: PipelineProfile;
  readonly profileId?: string;
  readonly gh?: GhScenario;
  readonly integrator?: IntegratorOutcome;
  readonly agent?: AgentSpec;
  readonly developerWrite?: boolean;
  readonly cleanup?: Readonly<{ releaseWorktreeFails?: boolean; dirtyWorktreeBeforeRelease?: boolean }>;
  readonly gates?: readonly GateStep[];
  readonly coverage: PipelineCaseAttachment;
  readonly expect: ScenarioExpect;
};

export type PipelineGiven = Readonly<{
  title: string;
  description?: string;
  scope?: string;
  repo: ScenarioRepo;
  playbook?: 'fixture' | 'default';
  playbookId?: string;
  pipelineId?: string;
  profile?: PipelineProfile;
  profileId?: string;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: boolean;
  cleanup?: Readonly<{ releaseWorktreeFails?: boolean; dirtyWorktreeBeforeRelease?: boolean }>;
}>;

export type PipelineAction =
  | Readonly<{ do: 'answer'; answer: unknown; summaryIncludes?: readonly string[] }>
  | Readonly<{
      do: 'resolveGate';
      topic: GateTopic;
      options: readonly string[];
      outcome: string;
      nodeId?: string;
      note?: string;
      reconcile?: 'keep';
      mergeOverrideAudit?: Record<string, unknown>;
      summaryIncludes?: readonly string[];
      artifactHeadSha?: string;
      requirePlanArtifact?: boolean;
      pendingRisk?: Readonly<{ topic: string; kind: string }>;
    }>
  | Readonly<{ do: 'rejectGate'; topic: GateTopic; options: readonly string[]; nodeId?: string }>
  | Readonly<{ do: 'cancelRun'; topic: GateTopic; options: readonly string[] }>;

export type PipelineThen = ScenarioExpect;
export type PipelineCase = Readonly<{
  coverage: PipelineCaseAttachment;
  given: PipelineGiven;
  when: readonly PipelineAction[];
  then: PipelineThen;
}>;

function repoPath(repo: ScenarioRepo | undefined): string {
  if (repo === undefined) throw new Error('pipelineScenario requires an explicit repo');
  if (repo === 'workspace') return process.cwd();
  const target = targetRepos.get(repo);
  if (!target) throw new Error('pipeline target must be created by its owning context');
  return target.worktree;
}

function runProfile(profile: PipelineProfile): E2eRunProfile {
  if (profile === 'default-agent') return stubDefaultAgentProfile();
  if (profile === 'default-full') return stubDefaultFullProfile();
  if (profile === 'fixture-full') return stubFixtureFullProfile();
  if (profile === 'fixture-integrator') return stubFixtureIntegratorProfile();
  return stubFixtureAgentProfile();
}

function playbookId(scenario: PipelineCasePlan): string {
  if (scenario.playbookId) return scenario.playbookId;
  return scenario.playbook === 'default' ? DEFAULT_PLAYBOOK_ID : PLAYBOOK_ID;
}

function assertSummaryIncludes(
  topic: string,
  context: Record<string, unknown>,
  needles: readonly string[] | undefined,
): void {
  if (!needles || needles.length === 0) return;
  const summary = context['summary'];
  assert.ok(summary !== null && typeof summary === 'object' && !Array.isArray(summary), `${topic} must include a summary`);
  for (const needle of needles) {
    assert.ok(
      JSON.stringify(summary).includes(needle),
      `expected ${topic} summary to include ${JSON.stringify(needle)}; got ${JSON.stringify(summary)}`,
    );
  }
}

function assertGateContext(
  gate: { topic: string; context: Record<string, unknown> },
  expected: GateResolutionStep | GateActionStep,
): void {
  const summary = gate.context['summary'];
  assert.ok(summary !== null && typeof summary === 'object' && !Array.isArray(summary), `${gate.topic} gate must include a summary`);
  const summaryRecord = summary as Record<string, unknown>;
  if (expected.nodeId) {
    assert.equal(summaryRecord['nodeId'], expected.nodeId, `expected ${gate.topic} gate node ${expected.nodeId}`);
  }
  assertSummaryIncludes(`${gate.topic} gate`, gate.context, expected.summaryIncludes);
  if (expected.artifactHeadSha) {
    const artifact = summaryRecord['gatedArtifact'];
    assert.ok(
      artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact),
      `${gate.topic} gate must include a gated artifact`,
    );
    const payload = (artifact as Record<string, unknown>)['payload'];
    assert.ok(
      payload !== null && typeof payload === 'object' && !Array.isArray(payload),
      `${gate.topic} gate gated artifact must include an inline payload`,
    );
    assert.equal(
      (payload as Record<string, unknown>)['headSha'],
      expected.artifactHeadSha,
      `expected ${gate.topic} gate artifact head ${expected.artifactHeadSha}`,
    );
  }
  if (expected.requirePlanArtifact) {
    const artifact = summaryRecord['gatedArtifact'];
    assert.ok(artifact !== null && typeof artifact === 'object' && !Array.isArray(artifact));
    const artifactRecord = artifact as Record<string, unknown>;
    assert.equal(artifactRecord['nodeId'], 'analyst');
    assert.equal(artifactRecord['name'], 'plan');
    assert.ok(artifactRecord['payload'] !== undefined || artifactRecord['preview'] !== undefined);
    assert.ok(summaryRecord['reviewerVerdict'], 'plan gate must include the reviewer verdict');
  }
}

async function waitForQuestion(
  api: TaskControlPlaneApiService,
  runId: string,
): Promise<{ inboxId: string; context: Record<string, unknown> }> {
  const state = await waitState(api, runId);
  assert.equal(state.state, 'question', `expected question, got ${state.state}`);
  const inbox = state.inbox;
  assert.ok(inbox, 'question must include the inbox item to resolve');
  const context = inbox.context;
  assert.ok(context !== null && typeof context === 'object' && !Array.isArray(context));
  return { inboxId: inbox.id, context: context as Record<string, unknown> };
}

function eventMatches(event: { type: string; payload: unknown }, expected: EventPathItem): boolean {
  if (typeof expected === 'string') return event.type === expected;
  if (event.type !== expected.type) return false;
  if (!expected.payload) return true;
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return Object.entries(expected.payload).every(([key, value]) => record[key] === value);
}

async function assertEventPath(api: TaskControlPlaneApiService, runId: string, path: readonly EventPathItem[]): Promise<void> {
  let events = await api.getRunEvents({ runId, limit: 500 });
  const pathVisible = () => {
    let from = 0;
    for (const expected of path) {
      const next = events.findIndex((event, index) => index >= from && eventMatches(event, expected));
      if (next < 0) return false;
      from = next + 1;
    }
    return true;
  };
  for (let waited = 0; waited < 8_000 && !pathVisible(); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = await api.getRunEvents({ runId, limit: 500 });
  }
  assert.ok(pathVisible(), `expected event path ${JSON.stringify(path)} for ${runId}`);
}

async function assertNoEvents(api: TaskControlPlaneApiService, runId: string, types: readonly string[]): Promise<void> {
  for (let waited = 0; waited <= NO_EVENT_SETTLE_MS; waited += NO_EVENT_POLL_MS) {
    const events = await api.getRunEvents({ runId, limit: 500 });
    for (const type of types) {
      assert.ok(!events.some((event) => event.type === type), `event "${type}" must not be visible`);
    }
    if (waited === NO_EVENT_SETTLE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, NO_EVENT_POLL_MS));
  }
}

async function assertEventsPresent(
  api: TaskControlPlaneApiService,
  runId: string,
  types: readonly string[],
): Promise<void> {
  const events = await waitForRunEvents(
    api,
    runId,
    (items) => types.every((type) => items.some((event) => event.type === type)),
  );
  for (const type of types) {
    assert.ok(events.some((event) => event.type === type), `event "${type}" must be visible`);
  }
}

async function assertNoRawTokenInEvents(
  api: TaskControlPlaneApiService,
  runId: string,
  rawToken: string,
): Promise<void> {
  const events = await api.getRunEvents({ runId, limit: 50 });
  assert.ok(!JSON.stringify(events).includes(rawToken), `raw token must not reach persisted events: ${rawToken}`);
}

async function assertRoleStepAfterEvent(
  api: TaskControlPlaneApiService,
  runId: string,
  role: string,
  afterEventType: string,
): Promise<void> {
  const events = await waitForRunEvents(
    api,
    runId,
    (items) => items.some((event) => event.type === afterEventType) && items.some((event) => {
      if (event.type !== 'step_succeeded' || event.payload === null || typeof event.payload !== 'object') return false;
      const stepRole = (event.payload as Record<string, unknown>)['role'];
      return typeof stepRole === 'string' && stepRole.endsWith(role);
    }),
  );
  const eventIndex = events.findIndex((event) => event.type === afterEventType);
  const stepIndex = events.findIndex((event) => {
    if (event.type !== 'step_succeeded' || event.payload === null || typeof event.payload !== 'object') return false;
    const stepRole = (event.payload as Record<string, unknown>)['role'];
    return typeof stepRole === 'string' && stepRole.endsWith(role);
  });
  assert.ok(eventIndex >= 0 && stepIndex > eventIndex, `${role} must execute after ${afterEventType}`);
}

function persistedPayload(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function assertBlockedDecision(
  api: TaskControlPlaneApiService,
  runId: string,
  expected: Readonly<{ reason?: string; lessonIncludes?: readonly string[] }>,
): Promise<void> {
  const events = await waitForRunEvents(api, runId, (items) => items.some((event) => {
    if (event.type !== 'pipeline_blocked') return false;
    const payload = persistedPayload(event.payload);
    if (!payload) return false;
    if (expected.reason !== undefined && payload['reason'] !== expected.reason) return false;
    const lesson = String(payload['lesson'] ?? '');
    return (expected.lessonIncludes ?? []).every((text) => lesson.includes(text));
  }));
  assert.ok(events.some((event) => event.type === 'pipeline_blocked'), 'blocked decision must be persisted');
}

async function assertFailureReason(
  api: TaskControlPlaneApiService,
  runId: string,
  expected: readonly string[],
): Promise<void> {
  const events = await waitForRunEvents(api, runId, (items) => items.some((event) => {
    if (event.type !== 'run_failed') return false;
    const payload = persistedPayload(event.payload);
    const reason = String(payload?.['reason'] ?? '');
    return expected.every((text) => reason.includes(text));
  }));
  assert.ok(events.some((event) => event.type === 'run_failed'), 'run failure reason must be persisted');
}

function matchesSideEffect(call: readonly string[], sideEffect: PipelineSideEffect): boolean {
  if (sideEffect === 'create_pull_request') return call[0] === 'pr' && call[1] === 'create';
  if (sideEffect === 'merge_pull_request') return call[0] === 'pr' && call[1] === 'merge';
  if (sideEffect === 'list_open_pull_requests') {
    return call[0] === 'pr' && call[1] === 'list' && call.includes('--state') && call.includes('open');
  }
  return call[0] === 'pr' && call[1] === 'list' && call.includes('--state') && call.includes('all');
}

function assertSideEffectAbsent(h: HostFixture, runCase: StartedPipelineCase, sideEffect: PipelineSideEffect): void {
  const prefix = taskBranchPrefix(runCase.taskId);
  assert.ok(
    !h.ghCalls.some((call) => matchesSideEffect(call, sideEffect) && call.some((arg) => arg.startsWith(prefix))),
    `${sideEffect} must not occur for ${runCase.runId}`,
  );
}

function assertSideEffectPresent(h: HostFixture, runCase: StartedPipelineCase, sideEffect: PipelineSideEffect): void {
  const prefix = taskBranchPrefix(runCase.taskId);
  assert.ok(
    h.ghCalls.some((call) => call.some((arg) => arg.startsWith(prefix)) && matchesSideEffect(call, sideEffect)),
    `${sideEffect} must occur for ${runCase.runId}`,
  );
}

function assertReviewReplyIncludes(h: HostFixture, runCase: StartedPipelineCase, expected: string): void {
  const bodies = reviewReplyBodiesSince(h.ghCalls, runCase.ghCallBoundary);
  assert.ok(
    bodies.some((body) => body.includes(expected)),
    `expected a review-thread reply body to include ${JSON.stringify(expected)}; got ${JSON.stringify(bodies)}`,
  );
}

function applyGateTimeContext(
  h: HostFixture,
  runCase: StartedPipelineCase,
  step: GateResolutionStep,
): void {
  if (step.outcome === 'override_merge' && runCase.gh === 'force-advisory-thread') {
    h.casePlans.showAdvisoryThread(runCase.taskId);
  }
}

function agentCallsFor(h: HostFixture, runId: string, role: string) {
  return h.agentCalls.filter((call) => call.runId === runId && call.role === role);
}

function repoFromContext(context: string): string {
  const repo = /^Repo: (.+)$/m.exec(context)?.[1]?.trim();
  assert.ok(repo, 'agent context must include the execution repository');
  return repo;
}

function retryContext(stepInput: unknown): Record<string, unknown> {
  assert.ok(stepInput !== null && typeof stepInput === 'object' && !Array.isArray(stepInput));
  const value = (stepInput as Record<string, unknown>)['retryContext'];
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'agent retry must include retryContext');
  return value as Record<string, unknown>;
}

async function executePipelineCase(
  h: HostFixture,
  scenario: PipelineCasePlan,
): Promise<void> {
  if (scenario.coverage.kind === 'registered-dsl') {
    if (playbookId(scenario) !== DEFAULT_PLAYBOOK_ID) {
      throw new Error('registered pipeline attachment does not match the selected materialized identity');
    }
    validatePipelineCaseAttachment(
      scenario.coverage,
      materializedCoverageIdentity(
        scenario.pipelineId ?? 'feature-development',
        scenario.profileId ?? 'base',
      ),
    );
  } else {
    validatePipelineCaseAttachment(scenario.coverage);
  }
  const repo = repoPath(scenario.repo);
  const created = await h.api.createRun({
    repo,
    title: scenario.title,
    description: scenario.description ?? scenario.title,
    scope: scenario.scope ?? scenario.title,
    playbookId: playbookId(scenario),
    pipelineId: scenario.pipelineId ?? 'feature-development',
    ...(scenario.profileId
      ? { profileId: scenario.profileId }
      : {
          profile: runProfile(
            scenario.profile ?? (scenario.playbook === 'default' ? 'default-agent' : 'fixture-agent'),
          ),
        }),
    start: false,
  });
  const runCase: StartedPipelineCase = {
    runId: created.runId,
    taskId: created.taskId,
    ghCallBoundary: caseGhCallBoundary(h.ghCalls),
    title: scenario.title,
    coverage: scenario.coverage,
    ...(scenario.gh ? { gh: scenario.gh } : {}),
    ...(scenario.integrator ? { integrator: scenario.integrator } : {}),
    ...(scenario.agent ? { agent: scenario.agent } : {}),
    ...(scenario.developerWrite === false ? {} : { developerWrite: repo }),
    ...(scenario.cleanup ? { cleanup: scenario.cleanup } : {}),
  };
  h.casePlans.register(created.taskId, {
    title: runCase.title,
    ...(runCase.gh ? { gh: runCase.gh } : {}),
    ...(runCase.integrator ? { integrator: runCase.integrator } : {}),
    ...(runCase.agent ? { agent: runCase.agent } : {}),
    ...(runCase.developerWrite ? { developerWrite: runCase.developerWrite } : {}),
    ...(runCase.cleanup ? { cleanup: runCase.cleanup } : {}),
  });

  const started = await h.api.startRun({ runId: created.runId });
  if (scenario.expect.engine) {
    assert.equal((started as { engine?: string }).engine, scenario.expect.engine);
  }

  for (const step of scenario.gates ?? []) {
    if ('answer' in step) {
      const question = await waitForQuestion(h.api, created.runId);
      assertSummaryIncludes('question', question.context, step.summaryIncludes);
      await h.api.answerQuestion({
        inboxId: question.inboxId,
        answer: step.answer,
        resolvedBy: 'e2e',
      });
      continue;
    }
    const gate = step.action === undefined
      ? await waitForExpectedGate(h.api, created.runId, {
          topic: step.topic,
          options: step.options,
          outcome: step.outcome,
        })
      : await waitForExpectedGate(h.api, created.runId, {
          topic: step.topic,
          options: step.options,
        });
    assertGateContext(gate, step);
    if (step.pendingRisk) {
      const pending = await h.api.getPendingDecisions(created.runId);
      assert.ok(pending.some((item) => item.id === gate.inboxId));
      const risk = await h.api.summarizeGateRisk(gate.inboxId);
      assert.equal(risk.topic, step.pendingRisk.topic);
      assert.equal(risk.kind, step.pendingRisk.kind);
    }
    if (step.action !== undefined) {
      if (step.action === 'reject') {
        await h.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: 'e2e' });
      } else {
        await h.api.cancelRun(created.runId);
        await h.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: 'e2e' }).catch(() => undefined);
      }
      continue;
    }
    applyGateTimeContext(h, runCase, step);
    await h.api.resolveGate({
      inboxId: gate.inboxId,
      outcome: step.outcome,
      resolvedBy: 'e2e',
      ...(step.reconcile ? { reconcile: step.reconcile } : {}),
      ...(step.note ? { note: step.note } : {}),
      ...(step.mergeOverrideAudit ? { mergeOverrideAudit: step.mergeOverrideAudit } : {}),
    });
  }

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, scenario.expect.terminal);

  if (scenario.expect.events) await assertEventsPresent(h.api, created.runId, scenario.expect.events);
  if (scenario.expect.noEvents) await assertNoEvents(h.api, created.runId, scenario.expect.noEvents);
  if (scenario.expect.path) await assertEventPath(h.api, created.runId, scenario.expect.path);
  if (scenario.expect.blockedDecision) {
    await assertBlockedDecision(h.api, created.runId, scenario.expect.blockedDecision);
  }
  if (scenario.expect.failureReasonIncludes) {
    await assertFailureReason(h.api, created.runId, scenario.expect.failureReasonIncludes);
  }
  for (const sideEffect of scenario.expect.sideEffects ?? []) {
    assertSideEffectPresent(h, runCase, sideEffect);
  }
  for (const sideEffect of scenario.expect.forbiddenSideEffects ?? []) {
    assertSideEffectAbsent(h, runCase, sideEffect);
  }
  for (const role of scenario.expect.agentCalled ?? []) {
    assert.ok(
      h.agentCalls.some((call) => call.runId === created.runId && call.role === role),
      `agent role ${role} must be called for ${created.runId}`,
    );
  }
  for (const nodeId of scenario.expect.agentNodeCalled ?? []) {
    assert.ok(
      h.agentCalls.some((call) => call.runId === created.runId && call.nodeId === nodeId),
      `agent node ${nodeId} must be called for ${created.runId}`,
    );
  }
  for (const [role, count] of Object.entries(scenario.expect.agentCallCount ?? {})) {
    assert.equal(agentCallsFor(h, created.runId, role).length, count, `${role} call count`);
  }
  for (const [role, minimum] of Object.entries(scenario.expect.agentCallMinimum ?? {})) {
    assert.ok(agentCallsFor(h, created.runId, role).length >= minimum, `${role} call count must be at least ${minimum}`);
  }
  for (const role of scenario.expect.sameWorktreeForAgent ?? []) {
    const repos = new Set(agentCallsFor(h, created.runId, role).map((call) => repoFromContext(call.context)));
    assert.deepEqual([...repos], [worktreePathFor(getConfig().dataDir, created.runId)]);
  }
  for (const expected of scenario.expect.agentRetryContexts ?? []) {
    const calls = agentCallsFor(h, created.runId, expected.role);
    const actual = retryContext(calls[expected.callIndex]?.stepInput);
    assert.equal(actual['kind'], expected.kind);
    assert.equal(actual['nodeId'], expected.nodeId);
    assert.deepEqual(actual['answer'], expected.answer);
    assert.equal(actual['lesson'], expected.lesson);
    assert.equal(actual['resolvedBy'], expected.resolvedBy);
    assert.match(String(actual['inboxId']), /^inbox_/);
    if (expected.distinctInboxFromCallIndex !== undefined) {
      const other = retryContext(calls[expected.distinctInboxFromCallIndex]?.stepInput);
      assert.notEqual(actual['inboxId'], other['inboxId']);
    }
  }
  for (const [role, needles] of Object.entries(scenario.expect.agentContextIncludes ?? {})) {
    const calls = agentCallsFor(h, created.runId, role);
    assert.ok(calls.length > 0, `${role} must execute`);
    const combined = calls.map((call) => call.context).join('\n');
    for (const needle of needles) {
      assert.ok(combined.includes(needle), `${role} context must include ${JSON.stringify(needle)}`);
    }
  }
  for (const expected of scenario.expect.agentAfterEvent ?? []) {
    await assertRoleStepAfterEvent(h.api, created.runId, expected.role, expected.event);
  }
  if (scenario.expect.reviewerConsensus) {
    const workflow = await h.api.getRunWorkflow(created.runId);
    const reviewNodes = workflow.nodes.filter((node) => node.roleId === 'reviewer');
    assert.deepEqual(
      reviewNodes.map((node) => node.id).sort(),
      [...scenario.expect.reviewerConsensus.nodeIds].sort(),
    );
    assert.deepEqual(
      reviewNodes.map((node) => node.verdict).sort(),
      [...scenario.expect.reviewerConsensus.verdicts].sort(),
    );
    assert.ok(reviewNodes.every((node) => node.attemptCount === 1), 'each reviewer branch executes once');
    if (scenario.expect.reviewerConsensus.attemptVerdicts) {
      assert.deepEqual(
        workflow.attempts.map((attempt) => attempt.verdict).sort(),
        [...scenario.expect.reviewerConsensus.attemptVerdicts].sort(),
      );
    }
    if (scenario.expect.reviewerConsensus.requireProcessArtifacts) {
      assert.ok(workflow.attempts.every((attempt) => attempt.artifactRef?.startsWith('test-artifacts/')));
    }
  }
  for (const value of scenario.expect.persistedDataExcludes ?? []) {
    await assertNoRawTokenInEvents(h.api, created.runId, value);
  }
  for (const expected of scenario.expect.reviewReplyIncludes ?? []) {
    assertReviewReplyIncludes(h, runCase, expected);
  }
}

export class PipelineContext {
  readonly #host: HostFixture;
  readonly #targets: TargetRepo[] = [];

  constructor(host: HostFixture) {
    this.#host = host;
  }

  run(plan: PipelineCasePlan): Promise<void> {
    return executePipelineCase(this.#host, plan);
  }

  execute(casePlan: PipelineCase): Promise<void> {
    const gates: GateStep[] = casePlan.when.map((action): GateStep => {
      const actionKind = action.do;
      if (actionKind === 'answer') return { topic: 'question', answer: action.answer, summaryIncludes: action.summaryIncludes };
      if (actionKind === 'rejectGate') {
        return { topic: action.topic, options: action.options, nodeId: action.nodeId, action: 'reject' };
      }
      if (actionKind === 'cancelRun') {
        return { topic: action.topic, options: action.options, action: 'cancel-run' };
      }
      return {
        topic: action.topic,
        options: action.options,
        outcome: action.outcome,
        nodeId: action.nodeId,
        note: action.note,
        reconcile: action.reconcile,
        mergeOverrideAudit: action.mergeOverrideAudit,
        summaryIncludes: action.summaryIncludes,
        artifactHeadSha: action.artifactHeadSha,
        requirePlanArtifact: action.requirePlanArtifact,
        pendingRisk: action.pendingRisk,
      };
    });
    return this.run({ ...casePlan.given, coverage: casePlan.coverage, gates, expect: casePlan.then });
  }

  target(): PipelineTarget {
    const repo = createTargetRepo();
    this.#targets.push(repo);
    return pipelineTarget(repo);
  }

  async close(): Promise<void> {
    try {
      await this.#host.close();
    } finally {
      for (const target of this.#targets.splice(0)) target.cleanup();
    }
  }
}

export async function createPipelineContext(): Promise<PipelineContext> {
  const host = await createHostFixture();
  try {
    await givenInstalledPlaybook(host);
    return new PipelineContext(host);
  } catch (error) {
    await host.close();
    throw error;
  }
}
