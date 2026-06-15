import assert from 'node:assert/strict';
import { PLAYBOOK_SOURCE } from './env.js';
import type { RunHarness } from './harness.js';
import type { TargetRepo } from './git-target-repo.js';
import { waitForGate } from './drive.js';

/** Playbook id installed by {@link givenInstalledPlaybook}. */
export const PLAYBOOK_ID = 'revisium-agent-playbook';

const STUB_OVERRIDE = { runnerOverrides: { 'claude-code': 'stub-agent' } };

/**
 * Install the agent playbook into the control-plane (roles + pipelines), idempotently.
 * The control-plane is shared across e2e files; skip the (commit-ing) install when the playbook
 * is already present, so a second file does not race/duplicate the draft commit.
 */
export async function givenInstalledPlaybook(h: RunHarness): Promise<void> {
  const alreadyInstalled = await h.api.getPipeline('feature-development').then(
    () => true,
    () => false,
  );
  if (alreadyInstalled) return;
  const install = await h.api.installPlaybook({ source: PLAYBOOK_SOURCE, name: PLAYBOOK_ID, commit: true });
  assert.equal(install.playbookId, PLAYBOOK_ID);
  assert.ok(install.roles > 0, 'playbook install must load roles');
  assert.ok(install.pipelines > 0, 'playbook install must load pipelines');
}

/** Create + start a `local-change` run (developer-only, stub agent). Returns the started run. */
export async function startLocalChangeRun(h: RunHarness, repo: string = process.cwd()) {
  const created = await h.api.createRun({
    repo,
    title: 'E2E local-change deterministic agent',
    description: 'Real DBOS/Revisium run; deterministic test agent replaces claude-code only.',
    scope: 'No source changes.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'local-change',
    executionProfile: STUB_OVERRIDE,
    start: true,
  });
  if (!('workflow' in created)) throw new Error('start:true must return workflow metadata');
  return created;
}

/** Create + start a `feature-development` run against `target`, registering the developer write. */
export async function startFeatureRun(h: RunHarness, target: TargetRepo) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E feature-development deterministic agent',
    description: 'Real DBOS/Revisium gates, real git integrator, deterministic agent and fake GitHub.',
    scope: 'Only mutate the temporary e2e target repository.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    executionProfile: STUB_OVERRIDE,
    start: true,
  });
  if (!('workflow' in created)) throw new Error('start:true must return workflow metadata');
  h.developerWrites.set(created.runId, target.worktree);
  return created;
}

/** Feature run driven to the `plan` gate (parked, awaiting decision). */
export async function givenFeatureRunAtPlanGate(h: RunHarness, target: TargetRepo) {
  const run = await startFeatureRun(h, target);
  const gate = await waitForGate(h.api, run.runId, 'plan');
  return { runId: run.runId, taskId: run.taskId, inboxId: gate.inboxId };
}

/** Feature run with `plan` approved, driven to the `merge` gate (parked, awaiting decision). */
export async function givenFeatureRunAtMergeGate(h: RunHarness, target: TargetRepo) {
  const run = await startFeatureRun(h, target);
  const plan = await waitForGate(h.api, run.runId, 'plan');
  await h.api.approveGate({ inboxId: plan.inboxId, resolvedBy: 'e2e' });
  const merge = await waitForGate(h.api, run.runId, 'merge');
  return { runId: run.runId, taskId: run.taskId, inboxId: merge.inboxId };
}
