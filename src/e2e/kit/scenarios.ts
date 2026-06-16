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

/**
 * Create + start a feature run with BOTH the agent and the integrator stubbed (script mode — no git
 * or gh). Used by the durability/recovery suite where integration is irrelevant and the run must
 * reach plan + merge gates and complete without external effects. `target` is only a valid repo path
 * (the stub integrator never touches it). Does NOT register a developer write (stub integrate ignores it).
 */
export async function startStubbedFeatureRun(h: RunHarness, target: TargetRepo) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E recovery feature run',
    description: 'Group F — durability/crash-recovery (stubbed agent + integrator).',
    scope: 'recovery e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
    start: true,
  });
  if (!('workflow' in created)) throw new Error('start:true must return workflow metadata');
  return { runId: created.runId, taskId: created.taskId };
}

/** Pipeline id of the DATA-DRIVEN feature pipeline (0015 slice 2) — embeds a state-machine template. */
export const DATA_DRIVEN_PIPELINE = 'feature-development-dd';

/**
 * Create + start a DATA-DRIVEN feature run (0015 slice 2) against `target`. Routes to the
 * data-driven DBOS adapter (the pipeline carries a template_json), with the agent + integrator stubbed
 * so the run reaches the plan + merge gates without real git/gh. `spec` is registered (when provided)
 * BEFORE start so the scripted agent reads this run's per-node verdicts (needs a routedScriptedAgent
 * harness). The data-driven watcher node routes on a `clean` DOMAIN verdict — the caller scripts it.
 */
export async function startDataDrivenRun(
  h: RunHarness,
  target: TargetRepo,
  specs?: Map<string, AgentSpecLike>,
  spec?: AgentSpecLike,
) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E data-driven feature run',
    description: 'Group L — data-driven pipeline (pipeline-core graph) on real DBOS.',
    scope: 'data-driven e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: DATA_DRIVEN_PIPELINE,
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
    start: false,
  });
  if (specs && spec) specs.set(created.runId, spec);
  const started = await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId, started };
}

/** Minimal structural alias so scenarios can take an AgentSpec without importing the concrete type here. */
export type AgentSpecLike = { byRole?: Record<string, unknown>; default?: unknown };

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
