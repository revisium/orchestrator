import assert from 'node:assert/strict';
import { taskBranchPrefix } from '../../runners/integrator-branch-naming.js';
import {
  resolveGateSequence,
  waitForGate,
  waitState,
  type ExpectedGateResolution,
} from './drive.js';
import { waitForRunEvents } from './persisted-facts.js';
import { createTargetRepo, git, type TargetRepo } from './git-target-repo.js';
import { createHostFixture, type HostFixture } from './harness.js';
import {
  PLAYBOOK_ID,
  givenInstalledPlaybook,
  startFeatureRun,
  startLocalChangeRun,
  startStubbedFeatureRun,
} from './scenarios.js';
import { stubFixtureAgentProfile } from './run-profiles.js';

export class ConcurrencyTarget {
  readonly #target: TargetRepo;

  constructor(target: TargetRepo) {
    this.#target = target;
  }

  supportTarget(): TargetRepo {
    return this.#target;
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

  cleanup(): void {
    this.#target.cleanup();
  }
}

export class ConcurrentRun {
  readonly runId: string;
  readonly taskId: string;
  readonly #host: HostFixture;

  constructor(host: HostFixture, run: { runId: string; taskId: string }) {
    this.#host = host;
    this.runId = run.runId;
    this.taskId = run.taskId;
  }

  async doubleStart(): Promise<void> {
    await Promise.all([
      this.#host.api.startRun({ runId: this.runId }),
      this.#host.api.startRun({ runId: this.runId }),
    ]);
  }

  async waitForState(): Promise<string> {
    return (await waitState(this.#host.api, this.runId)).state;
  }

  async waitForGate(topic: 'plan' | 'merge'): Promise<void> {
    await waitForGate(this.#host.api, this.runId, topic);
  }

  async resolveToTerminal(sequence: readonly ExpectedGateResolution[]): Promise<string> {
    return (await resolveGateSequence(this.#host.api, this.runId, sequence)).state;
  }

  async rejectGate(topic: 'plan' | 'merge'): Promise<void> {
    const gate = await waitForGate(this.#host.api, this.runId, topic);
    await this.#host.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: 'e2e' });
  }

  async status(): Promise<string> {
    return (await this.#host.api.getRun({ runId: this.runId })).run.status;
  }

  async expectEventCount(type: string, expected: number): Promise<void> {
    let events = await this.#host.api.getRunEvents({ runId: this.runId, limit: 500 });
    for (let waited = 0; waited < 8_000 && events.filter((event) => event.type === type).length < expected; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      events = await this.#host.api.getRunEvents({ runId: this.runId, limit: 500 });
    }
    assert.equal(events.filter((event) => event.type === type).length, expected, `${this.runId}: ${type}`);
  }

  async expectEvents(types: readonly string[]): Promise<void> {
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => types.every((type) => items.some((event) => event.type === type)),
    );
    for (const type of types) {
      assert.ok(events.some((event) => event.type === type), `event "${type}" must be visible`);
    }
  }

  prBranch(): string {
    const prefix = taskBranchPrefix(this.taskId);
    const list = this.#host.ghCalls.find((call) =>
      call[0] === 'pr' && call[1] === 'list' && call.some((arg) => arg.startsWith(prefix)));
    assert.ok(list, 'fake gh must list existing PRs for this branch before creating');
    const headIndex = list.indexOf('--head');
    assert.ok(headIndex >= 0, '--head flag not found in pr list');
    const branch = list[headIndex + 1];
    assert.ok(branch?.startsWith(prefix), `unexpected PR head branch: ${String(branch)}`);
    assert.ok(this.#host.ghCalls.some((call) => call[0] === 'pr' && call[1] === 'create' && call.includes(branch)));
    assert.ok(this.#host.ghCalls.some((call) => call[0] === 'pr' && call[1] === 'view' && call.includes(branch)));
    return branch;
  }
}

export class ConcurrencyContext {
  readonly #host: HostFixture;

  constructor(host: HostFixture) {
    this.#host = host;
  }

  createTarget(): ConcurrencyTarget {
    return new ConcurrencyTarget(createTargetRepo());
  }

  async startLocalChanges(count: number): Promise<readonly ConcurrentRun[]> {
    const runs = await Promise.all(Array.from({ length: count }, () => startLocalChangeRun(this.#host)));
    return runs.map((run) => new ConcurrentRun(this.#host, run));
  }

  async prepareDoubleStart(): Promise<ConcurrentRun> {
    const created = await this.#host.api.createRun({
      repo: process.cwd(),
      title: 'E2E concurrent double-start',
      description: 'Idempotent start under concurrency.',
      scope: 'No source changes.',
      playbookId: PLAYBOOK_ID,
      pipelineId: 'local-change',
      profile: stubFixtureAgentProfile(),
      start: false,
    });
    this.#host.casePlans.register(created.taskId, { title: 'concurrent double-start' });
    return new ConcurrentRun(this.#host, created);
  }

  async startFeatures(
    targets: readonly ConcurrencyTarget[],
    mode: 'stubbed' | 'real-git',
  ): Promise<readonly ConcurrentRun[]> {
    const starts = targets.map((target) => mode === 'stubbed'
      ? startStubbedFeatureRun(this.#host, target.supportTarget())
      : startFeatureRun(this.#host, target.supportTarget()));
    const runs = await Promise.all(starts);
    return runs.map((run) => new ConcurrentRun(this.#host, run));
  }

  close(): Promise<void> {
    return this.#host.close();
  }
}

export async function createConcurrencyContext(): Promise<ConcurrencyContext> {
  const host = await createHostFixture();
  try {
    await givenInstalledPlaybook(host);
    return new ConcurrencyContext(host);
  } catch (error) {
    await host.close();
    throw error;
  }
}
