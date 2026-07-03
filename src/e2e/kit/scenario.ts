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

type GateTopic = 'plan' | 'merge';
type GateStep =
  | readonly [GateTopic, string]
  | {
      topic: GateTopic;
      outcome: string;
      mergeOverrideAudit?: Record<string, unknown>;
    };

type EventPathItem = string | { type: string; payload?: Record<string, unknown> };

type ScenarioExpect = {
  terminal: string;
  events?: string[];
  noEvents?: string[];
  path?: EventPathItem[];
  ghNotCalled?: Array<readonly [string, string]>;
};

type ScenarioRepo = string | TargetRepo;

export type RunCase = {
  runId: string;
  taskId: string;
  title: string;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: string;
};

export type PipelineScenario = {
  title: string;
  description?: string;
  scope?: string;
  repo: ScenarioRepo;
  playbook?: 'fixture' | 'default';
  pipelineId?: string;
  executionProfile?: { runnerOverrides?: Record<string, string> };
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  agent?: AgentSpec;
  developerWrite?: boolean;
  gates?: GateStep[];
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

function normalizeGate(step: GateStep): { topic: GateTopic; outcome: string; mergeOverrideAudit?: Record<string, unknown> } {
  if ('topic' in step) {
    return {
      topic: step.topic,
      outcome: step.outcome,
      ...(step.mergeOverrideAudit ? { mergeOverrideAudit: step.mergeOverrideAudit } : {}),
    };
  }
  const [topic, outcome] = step;
  return { topic, outcome };
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
  const events = await api.getRunEvents({ runId, limit: 500 });
  for (const type of types) {
    assert.ok(!events.some((event) => event.type === type), `event "${type}" must not be visible`);
  }
}

function assertGhNotCalledForRun(h: RunHarness, runCase: RunCase, sub: readonly [string, string]): void {
  const prefix = taskBranchPrefix(runCase.taskId);
  assert.ok(
    !h.ghCalls.some((call) => call[0] === sub[0] && call[1] === sub[1] && call.some((arg) => arg.startsWith(prefix))),
    `gh ${sub.join(' ')} must not be called for ${runCase.runId}`,
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
    executionProfile: scenario.executionProfile ?? { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  const runCase: RunCase = {
    runId: created.runId,
    taskId: created.taskId,
    title: scenario.title,
    ...(scenario.gh ? { gh: scenario.gh } : {}),
    ...(scenario.integrator ? { integrator: scenario.integrator } : {}),
    ...(scenario.agent ? { agent: scenario.agent } : {}),
    ...(scenario.developerWrite === false ? {} : { developerWrite: repo }),
  };
  runCases.set(created.runId, runCase);
  if (runCase.developerWrite) h.developerWrites.set(created.runId, runCase.developerWrite);

  await h.api.startRun({ runId: created.runId });

  for (const step of scenario.gates ?? []) {
    const gateStep = normalizeGate(step);
    const gate = await waitForGate(h.api, created.runId, gateStep.topic);
    await h.api.resolveGate({
      inboxId: gate.inboxId,
      outcome: gateStep.outcome,
      resolvedBy: 'e2e',
      ...(gateStep.mergeOverrideAudit ? { mergeOverrideAudit: gateStep.mergeOverrideAudit } : {}),
    });
  }

  const terminal = await waitState(h.api, created.runId);
  assert.equal(terminal.state, scenario.expect.terminal);

  if (scenario.expect.events) await assertEventsPresent(h.api, created.runId, scenario.expect.events);
  if (scenario.expect.noEvents) await assertNoEvents(h.api, created.runId, scenario.expect.noEvents);
  if (scenario.expect.path) await assertEventPath(h.api, created.runId, scenario.expect.path);
  for (const sub of scenario.expect.ghNotCalled ?? []) {
    assertGhNotCalledForRun(h, runCase, sub);
  }

  return { runId: created.runId, taskId: created.taskId, runCase };
}
