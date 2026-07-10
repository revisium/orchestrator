import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { getConfig } from '../../config.js';
import { worktreeMarkerFor, worktreePathFor } from '../../control-plane/resolve-cwd.js';
import { branchName } from '../../runners/integrator.js';
import { taskBranchPrefix } from '../../runners/integrator-branch-naming.js';
import { AGENT_OUTPUT_STREAM_KEY, type AgentOutputEvent } from '../../observability/types.js';
import type { AgentSpec } from './agents.js';
import {
  readRunAttempts,
  readRunDigest,
  waitForRunDetail,
  waitForRunEvents,
} from './persisted-facts.js';
import type { GhScenario } from './gh-emulator.js';
import { createHostFixture, type HostFixture } from './harness.js';
import type { IntegratorOutcome } from './fake-integrator.js';
import {
  resolveExpectedGate,
  waitForExpectedGate,
  waitState,
  type ExpectedGate,
  type ExpectedGateResolution,
} from './drive.js';
import { DEFAULT_PLAYBOOK_ID, PLAYBOOK_ID, givenInstalledPlaybook } from './scenarios.js';
import { stubDefaultFullProfile, stubFixtureAgentProfile } from './run-profiles.js';
import { createTargetRepo, git, type TargetRepo, type TargetRepoState } from './git-target-repo.js';

export type IntegrationGhScenario = GhScenario;
export type IntegrationProfile = 'fixture-agent' | 'default-full';

export type IntegrationTarget = Readonly<{
  repairDirty(): void;
  baseObservation(): Readonly<{ branch: string; clean: boolean }>;
  commitsAhead(branch: string): number;
}>;

const integrationTargets = new WeakMap<IntegrationTarget, TargetRepo>();

class IntegrationTargetHandle implements IntegrationTarget {
  readonly #target: TargetRepo;

  constructor(target: TargetRepo) {
    this.#target = target;
  }

  repairDirty(): void {
    this.#target.repairDirty();
  }

  baseObservation(): Readonly<{ branch: string; clean: boolean }> {
    return {
      branch: git(this.#target.worktree, ['branch', '--show-current']).trim(),
      clean: git(this.#target.worktree, ['status', '--porcelain']).trim() === '',
    };
  }

  commitsAhead(branch: string): number {
    return Number(git(this.#target.worktree, ['rev-list', '--count', `origin/master..origin/${branch}`]).trim());
  }
}

function createIntegrationTarget(state: TargetRepoState = {}): Readonly<{
  handle: IntegrationTarget;
  repo: TargetRepo;
}> {
  const repo = createTargetRepo(state);
  const handle = new IntegrationTargetHandle(repo);
  integrationTargets.set(handle, repo);
  return { handle, repo };
}

function integrationRepoPath(repo: 'workspace' | IntegrationTarget): string {
  if (repo === 'workspace') return process.cwd();
  const target = integrationTargets.get(repo);
  if (!target) throw new Error('integration target must be created by its owning context');
  return target.worktree;
}

function integrationProfile(profile: IntegrationProfile | undefined) {
  if (profile === 'default-full') return stubDefaultFullProfile();
  return stubFixtureAgentProfile();
}

async function expectPersistedEvents(host: HostFixture, runId: string, types: readonly string[]): Promise<void> {
  const events = await waitForRunEvents(
    host.api,
    runId,
    (items) => types.every((type) => items.some((event) => event.type === type)),
  );
  for (const type of types) {
    assert.ok(events.some((event) => event.type === type), `event "${type}" must be visible`);
  }
}

function executionFacts(host: HostFixture, runId: string): Array<[string, string]> {
  return host.agentCalls
    .filter((call) => call.runId === runId)
    .map((call): [string, string] => [call.role, call.runner]);
}

function expectPullRequestOpened(host: HostFixture, taskId: string, repo: string): string {
  const prefix = taskBranchPrefix(taskId);
  const list = host.ghCalls.find((call) =>
    call[0] === 'pr' && call[1] === 'list' && call.some((arg) => arg.startsWith(prefix)));
  assert.ok(list, 'fake gh must list existing PRs for this branch before creating');
  const repoIndex = list.indexOf('--repo');
  assert.ok(repoIndex >= 0 && list[repoIndex + 1] === repo, `--repo ${repo} not found in pr list`);
  const headIndex = list.indexOf('--head');
  assert.ok(headIndex >= 0, '--head flag not found in pr list');
  const branch = list[headIndex + 1];
  assert.ok(branch?.startsWith(prefix), `unexpected PR head branch: ${String(branch)}`);
  assert.ok(host.ghCalls.some((call) => call[0] === 'pr' && call[1] === 'create' && call.includes(branch)));
  assert.ok(host.ghCalls.some((call) => call[0] === 'pr' && call[1] === 'view' && call.includes(branch)));
  return branch;
}

export type IntegrationCasePlan = Readonly<{
  title: string;
  repo: 'workspace' | IntegrationTarget;
  description?: string;
  scope?: string;
  playbookId?: string;
  pipelineId: string;
  profile?: IntegrationProfile;
  profileId?: string;
  params?: Readonly<Record<string, unknown>>;
  agent?: AgentSpec;
  gh?: GhScenario;
  integrator?: IntegratorOutcome;
  developerWrite?: boolean;
}>;

export type IntegrationStart = Readonly<{
  engine?: string;
  alreadyStarted: boolean;
  roleBindings: readonly Readonly<{ roleId: string; resolvedRunnerId: string }>[];
}>;

export class IntegrationRun {
  readonly runId: string;
  readonly taskId: string;
  readonly #host: HostFixture;
  readonly #route: { roleBindings?: Array<{ roleId: string; resolvedRunnerId: string }> };
  readonly #title: string;

  constructor(
    host: HostFixture,
    created: { runId: string; taskId: string; title?: string; route?: { roleBindings?: Array<{ roleId: string; resolvedRunnerId: string }> } },
  ) {
    this.#host = host;
    this.runId = created.runId;
    this.taskId = created.taskId;
    this.#title = created.title ?? '';
    this.#route = created.route ?? {};
  }

  async start(): Promise<IntegrationStart> {
    const started = await this.#host.api.startRun({ runId: this.runId });
    return {
      engine: (started as { engine?: string }).engine,
      alreadyStarted: started.alreadyStarted,
      roleBindings: (this.#route.roleBindings ?? []).map((binding) => ({
        roleId: binding.roleId,
        resolvedRunnerId: binding.resolvedRunnerId,
      })),
    };
  }

  async reattach(): Promise<Readonly<{ alreadyStarted: boolean; workflowId: string }>> {
    const result = await this.#host.api.startRun({ runId: this.runId });
    return { alreadyStarted: result.alreadyStarted, workflowId: result.workflowID };
  }

  async resolveGate(expected: ExpectedGateResolution): Promise<void> {
    await resolveExpectedGate(this.#host.api, this.runId, expected);
  }

  async waitAtGate(expected: ExpectedGate): Promise<void> {
    await waitForExpectedGate(this.#host.api, this.runId, expected);
  }

  async settle(expected: string): Promise<void> {
    const settled = await waitState(this.#host.api, this.runId);
    assert.equal(settled.state, expected);
  }

  async cancel(): Promise<void> {
    await this.#host.api.cancelRun(this.runId);
  }

  async expectCompleted(): Promise<void> {
    const detail = await waitForRunDetail(this.#host.api, this.runId, (item) => item.run.status === 'completed');
    assert.equal(detail.run.status, 'completed');
  }

  async expectBlocked(): Promise<void> {
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => items.some((event) => event.type === 'pipeline_blocked'),
      { intervalMs: 100 },
    );
    assert.ok(events.some((event) => event.type === 'pipeline_blocked'));
    assert.ok(!events.some((event) => event.type === 'run_failed'));
    const detail = await this.#host.api.getRun({ runId: this.runId });
    assert.notEqual(detail.run.status, 'completed');
    assert.notEqual(detail.run.status, 'failed');
  }

  async expectBlockedDecision(expected: Readonly<{
    reason: string;
    lessonIncludes: readonly string[];
  }>): Promise<void> {
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => items.some((event) => {
        if (event.type !== 'pipeline_blocked' || event.payload === null || typeof event.payload !== 'object') return false;
        const payload = event.payload as Record<string, unknown>;
        return payload['reason'] === expected.reason &&
          expected.lessonIncludes.every((text) => String(payload['lesson'] ?? '').includes(text));
      }),
    );
    const decision = events.find((event) => {
      if (event.type !== 'pipeline_blocked' || event.payload === null || typeof event.payload !== 'object') return false;
      return (event.payload as Record<string, unknown>)['reason'] === expected.reason;
    });
    assert.ok(decision, `blocked decision reason ${expected.reason} must be persisted`);
    const payload = decision.payload as Record<string, unknown>;
    for (const text of expected.lessonIncludes) {
      assert.ok(String(payload['lesson'] ?? '').includes(text), `blocked lesson must include ${JSON.stringify(text)}`);
    }
    await this.expectBlocked();
  }

  async expectEvents(types: readonly string[]): Promise<void> {
    await expectPersistedEvents(this.#host, this.runId, types);
  }

  async expectAttemptVerdicts(verdicts: readonly string[]): Promise<void> {
    const attempts = await readRunAttempts(this.#host.api, this.runId);
    assert.deepEqual(attempts.map((attempt) => attempt.verdict), verdicts);
    assert.ok(attempts.every((attempt) => attempt.artifactRef?.startsWith('test-artifacts/')));
  }

  async expectUsage(usage: Readonly<{ inputTokens: number; outputTokens: number; costAmount: number }>): Promise<void> {
    const digest = await readRunDigest(this.#host.api, this.runId);
    assert.equal(digest.run.status, 'completed');
    assert.equal(digest.pendingInbox.length, 0);
    assert.equal(digest.usage.inputTokens, usage.inputTokens);
    assert.equal(digest.usage.outputTokens, usage.outputTokens);
    assert.equal(digest.usage.costAmount, usage.costAmount);
  }

  expectExecutedRoles(expected: readonly (readonly [string, string])[]): void {
    assert.deepEqual(executionFacts(this.#host, this.runId), expected);
  }

  expectRoleExecuted(role: string, minimum = 1): void {
    const count = executionFacts(this.#host, this.runId).filter(([candidate]) => candidate === role).length;
    assert.ok(count >= minimum, `${role} must execute at least ${minimum} time(s)`);
  }

  expectPrOpened(repo = 'e2e/repo'): string {
    return expectPullRequestOpened(this.#host, this.taskId, repo);
  }

  async expectRoleAfterEvent(role: string, event: string): Promise<void> {
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => items.some((item) => item.type === event) && items.some((item) => {
        if (item.type !== 'step_succeeded' || item.payload === null || typeof item.payload !== 'object') return false;
        const stepRole = (item.payload as Record<string, unknown>)['role'];
        return typeof stepRole === 'string' && stepRole.endsWith(role);
      }),
    );
    const eventIndex = events.findIndex((item) => item.type === event);
    const stepIndex = events.findIndex((item) => {
      if (item.type !== 'step_succeeded' || item.payload === null || typeof item.payload !== 'object') return false;
      const stepRole = (item.payload as Record<string, unknown>)['role'];
      return typeof stepRole === 'string' && stepRole.endsWith(role);
    });
    assert.ok(eventIndex >= 0 && stepIndex > eventIndex, `${role} must execute after ${event}`);
  }

  async expectReplayIdempotent(): Promise<void> {
    await this.expectCompleted();
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => items.some((event) => event.type === 'run_completed'),
      { intervalMs: 100 },
    );
    assert.equal(events.filter((event) => event.type === 'run_completed').length, 1);
    const stepKeys = events
      .filter((event) => event.type === 'step_succeeded')
      .map((event) => String((event.payload as { stepKey?: unknown } | undefined)?.stepKey ?? ''));
    assert.equal(stepKeys.length, new Set(stepKeys).size);
  }

  expectWorktreeReleased(): void {
    assert.equal(existsSync(worktreePathFor(getConfig().dataDir, this.runId)), false);
  }

  worktreeObservation(): Readonly<{
    path: string;
    exists: boolean;
    markerExists: boolean;
    branch: string;
    expectedBranch: string;
    head: string;
    originMaster: string;
    files: readonly string[];
    aheadOfOriginMaster: number;
  }> {
    const path = worktreePathFor(getConfig().dataDir, this.runId);
    const present = existsSync(path);
    return {
      path,
      exists: present,
      markerExists: existsSync(worktreeMarkerFor(getConfig().dataDir, this.runId)),
      branch: present ? git(path, ['branch', '--show-current']).trim() : '',
      expectedBranch: branchName(this.taskId, this.#title),
      head: present ? git(path, ['rev-parse', 'HEAD']).trim() : '',
      originMaster: present ? git(path, ['rev-parse', 'origin/master']).trim() : '',
      files: present ? git(path, ['ls-files']).split(/\r?\n/).filter(Boolean) : [],
      aheadOfOriginMaster: present
        ? Number(git(path, ['rev-list', '--count', 'origin/master..HEAD']).trim())
        : 0,
    };
  }

  async resumePreflightRecovery(target: IntegrationTarget): Promise<IntegrationRun> {
    let state = await waitState(this.#host.api, this.runId);
    for (let waited = 0; waited < 8_000 && state.workflowStatus !== 'SUCCESS'; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await this.#host.api.waitForRun({ runId: this.runId });
    }
    assert.equal(state.runStatus, 'paused');
    assert.equal(state.workflowStatus, 'SUCCESS');

    const blockedEvents = await this.#host.api.getRunEvents({
      runId: this.runId,
      type: 'pipeline_blocked',
      limit: 50,
    });
    const preflightEvent = blockedEvents.at(-1);
    assert.ok(preflightEvent);
    assert.equal((preflightEvent.payload as { reason?: unknown }).reason, 'preflight');

    const explicitStart = await this.#host.api.startRun({ runId: this.runId });
    assert.equal((explicitStart as { recoverable?: unknown }).recoverable, true);
    assert.equal((explicitStart as { retryStarted?: unknown }).retryStarted, false);
    assert.equal((explicitStart as { nextAction?: unknown }).nextAction, 'resume_run');

    const cancelReservation = this.#host.casePlans.reserveNext({
      title: `${this.#title} recovery`,
      developerWrite: integrationRepoPath(target),
    });
    try {
      const resumed = await this.#host.api.resumeRun({ runId: this.runId });
      if (!('recovery' in resumed)) throw new Error('resumeRun must return recovery lineage for a recoverable parent');
      assert.notEqual(resumed.runId, this.runId);
      assert.equal(resumed.workflowID, resumed.runId);
      assert.equal(resumed.recovery.parentRunId, this.runId);
      assert.equal(resumed.recovery.recoveryRunId, resumed.runId);
      assert.equal(resumed.recovery.blockedEventId, preflightEvent.eventId);
      assert.equal(resumed.recovery.reason, 'preflight');
      const resumedAgain = await this.#host.api.resumeRun({ runId: this.runId });
      assert.equal(resumedAgain.runId, resumed.runId);

      const detail = await this.#host.api.getRun({ runId: resumed.runId });
      const taskId = detail.tasks[0]?.taskId;
      assert.ok(taskId, 'recovery child must contain a task');
      assert.ok(this.#host.casePlans.get(taskId), 'recovery child must claim its pre-start case plan');
      return new IntegrationRun(this.#host, {
        runId: resumed.runId,
        taskId,
        title: `${this.#title} recovery`,
      });
    } finally {
      cancelReservation();
    }
  }

  async expectRecoveryLineage(child: IntegrationRun): Promise<void> {
    const parentEvents = await this.#host.api.getRunEvents({ runId: this.runId, limit: 500 });
    const childEvents = await this.#host.api.getRunEvents({ runId: child.runId, limit: 500 });
    const parentLineage = parentEvents.find((event) => event.type === 'run_recovery_created');
    const childLineage = childEvents.find((event) => event.type === 'run_recovery_parent');
    assert.ok(parentLineage);
    assert.ok(childLineage);
    assert.deepEqual(parentLineage.payload, childLineage.payload);
  }

  async expectAgentOutput(marker: string): Promise<void> {
    const events: AgentOutputEvent[] = [];
    for await (const event of this.#host.dbos.readStream<AgentOutputEvent>(this.runId, AGENT_OUTPUT_STREAM_KEY)) {
      events.push(event);
    }
    assert.ok(events.length > 0, 'agent output stream must contain reporter events');
    assert.ok(events.some((event) => JSON.stringify(event).includes(marker)));
  }
}

export class IntegrationContext {
  readonly #host: HostFixture;
  readonly #targets: TargetRepo[] = [];

  constructor(host: HostFixture) {
    this.#host = host;
  }

  async prepare(plan: IntegrationCasePlan): Promise<IntegrationRun> {
    const repo = integrationRepoPath(plan.repo);
    const created = await this.#host.api.createRun({
      repo,
      title: plan.title,
      description: plan.description ?? plan.title,
      scope: plan.scope ?? plan.title,
      playbookId: plan.playbookId ?? PLAYBOOK_ID,
      pipelineId: plan.pipelineId,
      ...(plan.profileId ? { profileId: plan.profileId } : { profile: integrationProfile(plan.profile) }),
      ...(plan.params ? { params: plan.params } : {}),
      start: false,
    });
    this.#host.casePlans.register(created.taskId, {
      title: plan.title,
      ...(plan.agent ? { agent: plan.agent } : {}),
      ...(plan.gh ? { gh: plan.gh } : {}),
      ...(plan.integrator ? { integrator: plan.integrator } : {}),
      ...(plan.developerWrite === false ? {} : { developerWrite: repo }),
    });
    return new IntegrationRun(this.#host, { ...created, title: plan.title });
  }

  target(state: TargetRepoState = {}): IntegrationTarget {
    const created = createIntegrationTarget(state);
    this.#targets.push(created.repo);
    return created.handle;
  }

  async close(): Promise<void> {
    try {
      await this.#host.close();
    } finally {
      for (const target of this.#targets.splice(0)) target.cleanup();
    }
  }
}

export async function createIntegrationContext(): Promise<IntegrationContext> {
  const host = await createHostFixture();
  try {
    await givenInstalledPlaybook(host);
    return new IntegrationContext(host);
  } catch (error) {
    await host.close();
    throw error;
  }
}

export { DEFAULT_PLAYBOOK_ID };
