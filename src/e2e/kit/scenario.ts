import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import { taskBranchPrefix } from '../../runners/integrator-branch-naming.js';
import type { AgentSpec } from './agents.js';
import type { IntegratorOutcome } from './fake-integrator.js';
import type { GhScenario } from './gh-emulator.js';
import type { TargetRepo } from './git-target-repo.js';
import type { RunHarness } from './harness.js';
import { assertEventsPresent } from './assertions.js';
import { waitForGate, waitState } from './drive.js';
import { DEFAULT_PLAYBOOK_ID, PLAYBOOK_ID } from './scenarios.js';
import { stubDefaultAgentProfile, stubFixtureAgentProfile, type E2eRunProfile } from './run-profiles.js';
import type { PipelineScenarioCoverage } from '../../control-plane/pipeline-coverage-registry.js';

type GateTopic = 'plan' | 'merge' | 'question' | 'retry';
type GateStep =
  | readonly [GateTopic, string]
  | {
      topic: 'question';
      answer: unknown;
      summaryIncludes?: string[];
    }
  | {
      topic: GateTopic;
      outcome: string;
      reconcile?: 'keep';
      note?: string;
      mergeOverrideAudit?: Record<string, unknown>;
      nodeId?: string;
      summaryIncludes?: string[];
      artifactHeadSha?: string;
    };

type EventPathItem = string | { type: string; payload?: Record<string, unknown> };

type ScenarioExpect = {
  terminal: string;
  events?: string[];
  noEvents?: string[];
  path?: EventPathItem[];
  ghCalled?: Array<readonly string[]>;
  ghNotCalled?: Array<readonly [string, string]>;
  agentCalled?: string[];
  agentNodeCalled?: string[];
};

type ScenarioRepo = string | TargetRepo;

const NO_EVENT_SETTLE_MS = 1_000;
const NO_EVENT_POLL_MS = 100;

export type RunCase = {
  runId: string;
  taskId: string;
  title: string;
  coverage?: PipelineScenarioCoverage;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: string;
  cleanup?: { releaseWorktreeFails?: boolean; dirtyWorktreeBeforeRelease?: boolean };
  forceAdvisoryThreadVisible?: boolean;
};

export type PipelineScenario = {
  title: string;
  description?: string;
  scope?: string;
  repo: ScenarioRepo;
  playbook?: 'fixture' | 'default';
  pipelineId?: string;
  profile?: E2eRunProfile;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: boolean;
  cleanup?: { releaseWorktreeFails?: boolean; dirtyWorktreeBeforeRelease?: boolean };
  gates?: GateStep[];
  coverage?: PipelineScenarioCoverage;
  expect: ScenarioExpect;
};

function repoPath(repo: ScenarioRepo | undefined): string {
  if (repo === undefined) throw new Error('pipelineScenario requires an explicit repo');
  if (typeof repo === 'string') return repo;
  return repo.worktree;
}

function playbookId(scenario: PipelineScenario): string {
  return scenario.playbook === 'default' ? DEFAULT_PLAYBOOK_ID : PLAYBOOK_ID;
}

function normalizeGate(step: GateStep): {
  topic: GateTopic;
  outcome?: string;
  answer?: unknown;
  reconcile?: 'keep';
  note?: string;
  mergeOverrideAudit?: Record<string, unknown>;
  nodeId?: string;
  summaryIncludes?: string[];
  artifactHeadSha?: string;
} {
  if ('topic' in step) {
    if ('answer' in step) {
      return {
        topic: step.topic,
        answer: step.answer,
        ...(step.summaryIncludes ? { summaryIncludes: step.summaryIncludes } : {}),
      };
    }
    return {
      topic: step.topic,
      outcome: step.outcome,
      ...(step.reconcile ? { reconcile: step.reconcile } : {}),
      ...(step.note ? { note: step.note } : {}),
      ...(step.mergeOverrideAudit ? { mergeOverrideAudit: step.mergeOverrideAudit } : {}),
      ...(step.nodeId ? { nodeId: step.nodeId } : {}),
      ...(step.summaryIncludes ? { summaryIncludes: step.summaryIncludes } : {}),
      ...(step.artifactHeadSha ? { artifactHeadSha: step.artifactHeadSha } : {}),
    };
  }
  const [topic, outcome] = step;
  return { topic, outcome };
}

function assertSummaryIncludes(topic: string, context: Record<string, unknown>, needles: string[] | undefined): void {
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

function assertGateContext(gate: { topic: string; context: Record<string, unknown> }, expected: ReturnType<typeof normalizeGate>): void {
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

async function assertEventPath(api: TaskControlPlaneApiService, runId: string, path: EventPathItem[]): Promise<void> {
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

async function assertNoEvents(api: TaskControlPlaneApiService, runId: string, types: string[]): Promise<void> {
  for (let waited = 0; waited <= NO_EVENT_SETTLE_MS; waited += NO_EVENT_POLL_MS) {
    const events = await api.getRunEvents({ runId, limit: 500 });
    for (const type of types) {
      assert.ok(!events.some((event) => event.type === type), `event "${type}" must not be visible`);
    }
    if (waited === NO_EVENT_SETTLE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, NO_EVENT_POLL_MS));
  }
}

function assertGhNotCalledForRun(h: RunHarness, runCase: RunCase, sub: readonly [string, string]): void {
  const prefix = taskBranchPrefix(runCase.taskId);
  assert.ok(
    !h.ghCalls.some((call) => call[0] === sub[0] && call[1] === sub[1] && call.some((arg) => arg.startsWith(prefix))),
    `gh ${sub.join(' ')} must not be called for ${runCase.runId}`,
  );
}

function assertGhCalledForRun(h: RunHarness, runCase: RunCase, expected: readonly string[]): void {
  const prefix = taskBranchPrefix(runCase.taskId);
  assert.ok(
    h.ghCalls.some((call) => call.some((arg) => arg.startsWith(prefix)) && expected.every((arg) => call.includes(arg))),
    `gh call containing ${expected.join(' ')} must be called for ${runCase.runId}`,
  );
}

export async function pipelineScenario(
  h: RunHarness,
  runCases: Map<string, RunCase>,
  scenario: PipelineScenario,
): Promise<{ runId: string; taskId: string; runCase: RunCase }> {
  const repo = repoPath(scenario.repo);
  const created = await h.api.createRun({
    repo,
    title: scenario.title,
    description: scenario.description ?? scenario.title,
    scope: scenario.scope ?? scenario.title,
    playbookId: playbookId(scenario),
    pipelineId: scenario.pipelineId ?? 'feature-development',
    profile: scenario.profile ?? (
      scenario.playbook === 'default'
        ? stubDefaultAgentProfile()
        : stubFixtureAgentProfile()
    ),
    start: false,
  });
  const runCase: RunCase = {
    runId: created.runId,
    taskId: created.taskId,
    title: scenario.title,
    ...(scenario.coverage ? { coverage: scenario.coverage } : {}),
    ...(scenario.gh ? { gh: scenario.gh } : {}),
    ...(scenario.integrator ? { integrator: scenario.integrator } : {}),
    ...(scenario.agent ? { agent: scenario.agent } : {}),
    ...(scenario.developerWrite === false ? {} : { developerWrite: repo }),
    ...(scenario.cleanup ? { cleanup: scenario.cleanup } : {}),
  };
  runCases.set(created.runId, runCase);
  if (runCase.developerWrite) h.developerWrites.set(created.runId, runCase.developerWrite);

  await h.api.startRun({ runId: created.runId });

  for (const step of scenario.gates ?? []) {
    const gateStep = normalizeGate(step);
    if (gateStep.topic === 'question' && gateStep.answer !== undefined) {
      const question = await waitForQuestion(h.api, created.runId);
      assertSummaryIncludes('question', question.context, gateStep.summaryIncludes);
      await h.api.answerQuestion({
        inboxId: question.inboxId,
        answer: gateStep.answer,
        resolvedBy: 'e2e',
      });
      continue;
    }
    const gate = await waitForGate(h.api, created.runId, gateStep.topic);
    assertGateContext(gate, gateStep);
    const outcome = gateStep.outcome;
    if (typeof outcome !== 'string') {
      throw new Error(`${gateStep.topic} gate step must declare an outcome`);
    }
    if (outcome === 'override_merge' && runCase.gh === 'force-advisory-thread') {
      runCase.forceAdvisoryThreadVisible = true;
    }
    await h.api.resolveGate({
      inboxId: gate.inboxId,
      outcome,
      resolvedBy: 'e2e',
      ...(gateStep.reconcile ? { reconcile: gateStep.reconcile } : {}),
      ...(gateStep.note ? { note: gateStep.note } : {}),
      ...(gateStep.mergeOverrideAudit ? { mergeOverrideAudit: gateStep.mergeOverrideAudit } : {}),
    });
  }

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, scenario.expect.terminal);

  if (scenario.expect.events) await assertEventsPresent(h.api, created.runId, scenario.expect.events);
  if (scenario.expect.noEvents) await assertNoEvents(h.api, created.runId, scenario.expect.noEvents);
  if (scenario.expect.path) await assertEventPath(h.api, created.runId, scenario.expect.path);
  for (const expected of scenario.expect.ghCalled ?? []) {
    assertGhCalledForRun(h, runCase, expected);
  }
  for (const sub of scenario.expect.ghNotCalled ?? []) {
    assertGhNotCalledForRun(h, runCase, sub);
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

  return { runId: created.runId, taskId: created.taskId, runCase };
}
