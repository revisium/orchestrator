import assert from 'node:assert/strict';
import { PLAYBOOK_SOURCE } from './env.js';
import type { RunHarness } from './harness.js';
import type { TargetRepo } from './git-target-repo.js';
import { waitForGate } from './drive.js';

/** Playbook id installed by {@link givenInstalledPlaybook}. */
export const PLAYBOOK_ID = 'revisium-agent-playbook';

const STUB_OVERRIDE = { runnerOverrides: { 'claude-code': 'stub-agent' } };

/**
 * Install the agent playbook into the control-plane (roles + pipelines).
 *
 * The control-plane is shared across e2e files (and persists between local runs). On a fresh
 * control-plane the first caller installs + commits it; a later caller re-committing the same
 * playbook fails with "revision is not a draft" (a benign no-op), which we swallow. Any other
 * failure is re-thrown. NB: a seeded pipeline is NOT proof the playbook is installed (bootstrap
 * seeds pipeline rows), so we must not gate on getPipeline — we install and tolerate re-install.
 */
export async function givenInstalledPlaybook(h: RunHarness): Promise<void> {
  // `listPlaybooks` is the accurate presence signal: bootstrap seeds pipeline/role rows but NOT a
  // playbook record, so this is empty until installed. Shared control-plane + sequential files →
  // the first run installs once, the rest skip (no redundant commit, no race).
  const installed = await h.api.listPlaybooks();
  if (installed.some((p) => p.id === PLAYBOOK_ID)) return;
  try {
    const install = await h.api.installPlaybook({ source: PLAYBOOK_SOURCE, name: PLAYBOOK_ID, commit: true });
    assert.equal(install.playbookId, PLAYBOOK_ID);
    assert.ok(install.roles > 0, 'playbook install must load roles');
    assert.ok(install.pipelines > 0, 'playbook install must load pipelines');
  } catch (err) {
    // Belt-and-suspenders: tolerate a concurrent/duplicate commit ("revision is not a draft");
    // re-throw anything that is not an already-installed signal.
    if (!/not a draft|already|nothing to commit|ROW_CONFLICT/i.test(String(err))) throw err;
  }
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
