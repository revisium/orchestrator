import assert from 'node:assert/strict';
import { PLAYBOOK_SOURCE } from './env.js';
import type { RunHarness } from './harness.js';
import type { TargetRepo } from './git-target-repo.js';

/** Playbook id installed by {@link givenInstalledPlaybook}. */
export const PLAYBOOK_ID = 'revisium-agent-playbook';

const STUB_OVERRIDE = { runnerOverrides: { 'claude-code': 'stub-agent' } };

/** Install the agent playbook into the control-plane (roles + pipelines). Run once per harness. */
export async function givenInstalledPlaybook(h: RunHarness): Promise<void> {
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
