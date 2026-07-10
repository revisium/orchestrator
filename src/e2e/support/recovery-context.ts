import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import type { AgentSpec } from './agents.js';
import { crashDataDrivenRunAt, crashRunAt, type CrashRunResult, type CrashStopPoint } from './crash.js';
import {
  resolveGateSequence,
  waitForGate,
  waitState,
  type ExpectedGateResolution,
} from './drive.js';
import { waitForRunDetail, waitForRunEvents } from './persisted-facts.js';
import { createTargetRepo } from './git-target-repo.js';
import { createHostFixture, type HostFixture } from './harness.js';
import {
  givenInstalledPlaybook,
  startDataDrivenRun,
  startStubbedFeatureRun,
} from './scenarios.js';

const CLEAN_WATCHER: AgentSpec = {
  byRole: { watcher: { kind: 'domainVerdict', verdict: 'clean' } },
};

export class RecoveredRun {
  readonly runId: string;
  readonly #host: HostFixture;

  constructor(host: HostFixture, runId: string) {
    this.#host = host;
    this.runId = runId;
  }

  async waitAtGate(topic: 'plan' | 'merge'): Promise<void> {
    await waitForGate(this.#host.api, this.runId, topic);
  }

  async resolveToCompletion(sequence: readonly ExpectedGateResolution[]): Promise<void> {
    const terminal = await resolveGateSequence(this.#host.api, this.runId, sequence);
    assert.equal(terminal.state, 'completed');
  }

  async rejectAtPlan(): Promise<void> {
    const gate = await waitForGate(this.#host.api, this.runId, 'plan');
    await this.#host.api.rejectGate({ inboxId: gate.inboxId, resolvedBy: 'e2e' });
    await waitState(this.#host.api, this.runId);
    const detail = await this.#host.api.getRun({ runId: this.runId });
    assert.notEqual(detail.run.status, 'completed');
  }

  expectEvents(types: readonly string[]): Promise<void> {
    return this.expectPersistedEvents(types);
  }

  async expectReplayExactlyOnce(): Promise<void> {
    const detail = await waitForRunDetail(this.#host.api, this.runId, (item) => item.run.status === 'completed');
    assert.equal(detail.run.status, 'completed');
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

  private async expectPersistedEvents(types: readonly string[]): Promise<void> {
    const events = await waitForRunEvents(
      this.#host.api,
      this.runId,
      (items) => types.every((type) => items.some((event) => event.type === type)),
    );
    for (const type of types) {
      assert.ok(events.some((event) => event.type === type), `event "${type}" must be visible`);
    }
  }
}

export class RecoveryContext {
  readonly #host: HostFixture;
  readonly #repos: readonly string[];

  constructor(host: HostFixture, repos: readonly string[]) {
    this.#host = host;
    this.#repos = repos;
  }

  run(runId: string): RecoveredRun {
    return new RecoveredRun(this.#host, runId);
  }

  async close(): Promise<void> {
    try {
      await this.#host.close();
    } finally {
      for (const repo of this.#repos) rmSync(dirname(repo), { recursive: true, force: true });
    }
  }
}

function cleanupCrashRepos(crashed: readonly CrashRunResult[]): void {
  for (const item of crashed) rmSync(dirname(item.repo), { recursive: true, force: true });
}

export type RecoveryCases = Readonly<{
  context: RecoveryContext;
  planResume: RecoveredRun;
  mergeResume: RecoveredRun;
  planReject: RecoveredRun;
}>;

export async function prepareRecoveryCases(): Promise<RecoveryCases> {
  process.env['REVO_PROJECT'] = 'agent-orchestrator-e2e-recovery';
  process.env['REVO_BRANCH'] = 'main';
  process.env['REVO_E2E_HARNESS_BOOTSTRAP'] = '1';

  const crashed: CrashRunResult[] = [];
  try {
    const planResume = await crashRunAt('plan-gate');
    crashed.push(planResume);
    const mergeResume = await crashRunAt('merge-gate');
    crashed.push(mergeResume);
    const planReject = await crashRunAt('plan-gate');
    crashed.push(planReject);
    const host = await createHostFixture({
      initialCasePlans: crashed.map((item) => ({
        taskId: item.taskId,
        plan: {
          title: `recovered ${item.taskId}`,
          developerWrite: item.repo,
          ...(item === mergeResume ? { gh: 'pr-already-exists' as const } : {}),
        },
      })),
    });
    const context = new RecoveryContext(host, crashed.map((item) => item.repo));
    return {
      context,
      planResume: context.run(planResume.runId),
      mergeResume: context.run(mergeResume.runId),
      planReject: context.run(planReject.runId),
    };
  } catch (error) {
    cleanupCrashRepos(crashed);
    throw error;
  }
}

export async function prepareDataDrivenRecovery(): Promise<Readonly<{
  context: RecoveryContext;
  mergeResume: RecoveredRun;
}>> {
  const mergeResume = await crashDataDrivenRunAt('merge-gate');
  try {
    const host = await createHostFixture({
      initialCasePlans: [{
        taskId: mergeResume.taskId,
        plan: {
          title: 'recovered data-driven feature',
          agent: CLEAN_WATCHER,
          developerWrite: mergeResume.repo,
          gh: 'pr-already-exists',
        },
      }],
    });
    const context = new RecoveryContext(host, [mergeResume.repo]);
    return { context, mergeResume: context.run(mergeResume.runId) };
  } catch (error) {
    cleanupCrashRepos([mergeResume]);
    throw error;
  }
}

export async function createCrashCheckpoint(options: Readonly<{
  dataDriven: boolean;
  stopAt: CrashStopPoint;
}>): Promise<CrashRunResult> {
  const host = await createHostFixture();
  const target = createTargetRepo();
  try {
    await givenInstalledPlaybook(host);
    const run = options.dataDriven
      ? await startDataDrivenRun(host, target, CLEAN_WATCHER)
      : await startStubbedFeatureRun(host, target);
    const plan = await waitForGate(host.api, run.runId, 'plan');
    if (options.stopAt === 'merge-gate') {
      await host.api.approveGate({ inboxId: plan.inboxId, resolvedBy: 'crash-child' });
      await waitForGate(host.api, run.runId, 'merge');
    }
    return { runId: run.runId, taskId: run.taskId, repo: target.worktree };
  } catch (error) {
    await host.close().catch(() => undefined);
    target.cleanup();
    throw error;
  }
}
