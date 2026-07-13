import assert from 'node:assert/strict';
import { PLAYBOOK_SOURCE } from './env.js';
import type { AgentSpec } from './agents.js';
import type { HostFixture } from './harness.js';
import type { TargetRepo } from './git-target-repo.js';
import { waitForGate } from './drive.js';
import {
  stubFixtureAgentProfile,
  stubFixtureFullProfile,
} from './run-profiles.js';

/** Playbook id installed by {@link givenInstalledPlaybook}. */
export const PLAYBOOK_ID = 'revisium-agent-playbook';

/**
 * Playbook id of the BUILT-IN DEFAULT playbook (slice 5) that host bootstrap seeds out-of-the-box.
 * Distinct from {@link PLAYBOOK_ID} (the e2e fixture) — Group M targets THIS to prove the shipped default.
 */
export const DEFAULT_PLAYBOOK_ID = 'revisium-default';

/**
 * Install the agent playbook into the control-plane (roles + pipelines).
 *
 * The control-plane is shared across e2e files (and persists between local runs). On a fresh
 * control-plane the first caller installs + commits it; a later caller re-committing the same
 * playbook fails with "revision is not a draft" (a benign no-op), which we swallow. Any other
 * failure is re-thrown. NB: a seeded pipeline is NOT proof the playbook is installed (bootstrap
 * seeds pipeline rows), so we must not gate on getPipeline — we install and tolerate re-install.
 */
export async function givenInstalledPlaybook(h: HostFixture): Promise<void> {
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
export async function startLocalChangeRun(h: HostFixture, repo: string = process.cwd()) {
  const created = await h.api.createRun({
    repo,
    title: 'E2E local-change deterministic agent',
    description: 'Real DBOS/Revisium run; deterministic test agent replaces claude-code only.',
    scope: 'No source changes.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'local-change',
    profile: stubFixtureAgentProfile('local-change'),
    start: false,
  });
  h.casePlans.register(created.taskId, { title: 'fixture local-change' });
  const workflow = await h.api.startRun({ runId: created.runId });
  return { ...created, workflow };
}

/** Create + start a `feature-development` run against `target`, registering the developer write. */
export async function startFeatureRun(h: HostFixture, target: TargetRepo) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E feature-development deterministic agent',
    description: 'Real DBOS/Revisium gates, real git integrator, deterministic agent and fake GitHub.',
    scope: 'Only mutate the temporary e2e target repository.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    profile: stubFixtureAgentProfile('feature-development'),
    start: false,
  });
  h.casePlans.register(created.taskId, { title: 'fixture feature-development', developerWrite: target.worktree });
  const workflow = await h.api.startRun({ runId: created.runId });
  return { ...created, workflow };
}

/**
 * Create + start a feature run with deterministic agents and fake GitHub. Used by the
 * durability/recovery suite where integration details are irrelevant and the run must reach plan +
 * merge gates and complete without external network effects.
 */
export async function startStubbedFeatureRun(h: HostFixture, target: TargetRepo) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E recovery feature run',
    description: 'Group F — durability/crash-recovery (deterministic agent + fake GitHub).',
    scope: 'recovery e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    profile: stubFixtureFullProfile('feature-development'),
    start: false,
  });
  h.casePlans.register(created.taskId, { title: 'runtime recovery feature run', developerWrite: target.worktree });
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

/** Pipeline id of the DATA-DRIVEN feature pipeline (0015 slice 2) — embeds a state-machine template. */
export const DATA_DRIVEN_PIPELINE = 'feature-development-dd';

/**
 * Create + start a DATA-DRIVEN feature run (0015 slice 2) against `target`. Routes to the
 * data-driven DBOS adapter (the pipeline carries a template_json), with deterministic agents and fake
 * GitHub so the run reaches the plan + merge gates without external network effects. `spec` is registered (when provided)
 * BEFORE start so the planned agent reads this task's per-node verdicts. The data-driven watcher node
 * routes on a `clean` DOMAIN verdict — the caller scripts it.
 */
export async function startDataDrivenRun(
  h: HostFixture,
  target: TargetRepo,
  spec?: AgentSpec,
) {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E data-driven feature run',
    description: 'Group L — data-driven pipeline (pipeline-core graph) on real DBOS.',
    scope: 'data-driven e2e',
    playbookId: PLAYBOOK_ID,
    pipelineId: DATA_DRIVEN_PIPELINE,
    profile: stubFixtureFullProfile('feature-development-dd'),
    start: false,
  });
  h.casePlans.register(created.taskId, {
    title: 'data-driven feature run',
    ...(spec ? { agent: spec } : {}),
    developerWrite: target.worktree,
  });
  const started = await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId, started };
}

/** Feature run driven to the `plan` gate (parked, awaiting decision). */
export async function givenFeatureRunAtPlanGate(h: HostFixture, target: TargetRepo) {
  const run = await startFeatureRun(h, target);
  const gate = await waitForGate(h.api, run.runId, 'plan');
  return { runId: run.runId, taskId: run.taskId, inboxId: gate.inboxId };
}
