import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import type { RunHarness } from './harness.js';
import { allSteps } from './drive.js';

type Api = TaskControlPlaneApiService;

/** Assert the run reached `completed` and left no claimable (`ready`) steps. Returns the detail. */
export async function assertCompleted(api: Api, runId: string) {
  const detail = await api.getRun({ runId, includeEvents: true, includeLog: true });
  assert.equal(detail.run.status, 'completed');
  assert.ok(allSteps(detail).every((s) => s.status !== 'ready'), 'terminal run must not leave ready steps');
  return detail;
}

/** Assert the recorded attempt verdicts (in order) and that each carries a process artifact ref. */
export async function assertAttemptVerdicts(api: Api, runId: string, verdicts: string[]) {
  const attempts = await api.getRunLog({ runId, limit: 50 });
  assert.deepEqual(attempts.map((a) => a.verdict), verdicts);
  assert.ok(attempts.every((a) => a.artifactRef?.startsWith('test-artifacts/')), 'attempts carry process artifact refs');
  return attempts;
}

/** Assert every listed event type is visible for the run. */
export async function assertEventsPresent(api: Api, runId: string, types: string[]) {
  const events = await api.getRunEvents({ runId, limit: 50 });
  for (const type of types) {
    assert.ok(events.some((e) => e.type === type), `event "${type}" must be visible`);
  }
}

/** Assert the run digest reports `completed`, no pending inbox, and the expected usage totals. */
export async function assertUsage(
  api: Api,
  runId: string,
  usage: { inputTokens: number; outputTokens: number; costAmount: number },
) {
  const digest = await api.getRunDigest(runId);
  assert.equal(digest.run.status, 'completed');
  assert.equal(digest.pendingInbox.length, 0);
  assert.equal(digest.usage.inputTokens, usage.inputTokens);
  assert.equal(digest.usage.outputTokens, usage.outputTokens);
  assert.equal(digest.usage.costAmount, usage.costAmount);
}

/** Roles + runners that actually executed for a run (from the deterministic agent's recorded calls). */
export function executedRoles(h: RunHarness, runId: string): Array<[string, string]> {
  return h.agentCalls.filter((c) => c.runId === runId).map((c): [string, string] => [c.role, c.runner]);
}

/**
 * Assert the fake gh opened a draft PR for the run's feature branch (list → create → view),
 * scoped by `taskId` so it is robust to other runs' gh calls. Returns the head branch name.
 */
export function assertPrOpened(h: RunHarness, taskId: string, repo = 'e2e/repo'): string {
  const branchPrefix = `feat/${taskId}-`;
  // Scope to THIS run's gh calls via the feature branch (robust if other runs share the harness).
  const list = h.ghCalls.find(
    (c) => c[0] === 'pr' && c[1] === 'list' && c.some((arg) => arg.startsWith(branchPrefix)),
  );
  assert.ok(list, 'fake gh must list existing PRs for this branch before creating');
  const repoIdx = list.indexOf('--repo');
  assert.ok(repoIdx >= 0 && list[repoIdx + 1] === repo, `--repo ${repo} not found in pr list`);
  const headIdx = list.indexOf('--head');
  assert.ok(headIdx >= 0, '--head flag not found in pr list');
  const branch = list[headIdx + 1];
  assert.ok(branch, '--head value missing in pr list');
  assert.ok(branch.startsWith(branchPrefix), `unexpected PR head branch: ${branch}`);
  assert.ok(
    h.ghCalls.some((c) => c[0] === 'pr' && c[1] === 'create' && c.includes(branch)),
    'fake gh must create a draft PR for this branch',
  );
  assert.ok(
    h.ghCalls.some((c) => c[0] === 'pr' && c[1] === 'view' && c.includes(branch)),
    'fake gh must read back created PR metadata for this branch',
  );
  return branch;
}
