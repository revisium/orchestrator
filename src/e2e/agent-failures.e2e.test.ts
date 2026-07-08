import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  routedScriptedAgent,
  type AgentSpec,
  createTargetRepo,
  type TargetRepo,
  waitState,
  waitForGate,
  approveUntilTerminal,
  executedRoles,
  assertEventsPresent,
} from './kit/index.js';

// Group C — agent failure modes injected via a per-run scripted agent. One real host per file.
let h: RunHarness;
const specs = new Map<string, AgentSpec>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ agent: (sink) => routedScriptedAgent(specs, sink) });
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

/** Create a feature run (not started), register its failure script, then start it. */
async function startFeatureWithSpec(target: TargetRepo, spec: AgentSpec): Promise<{ runId: string; taskId: string }> {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E agent-failure feature run',
    description: 'Group C — scripted agent failure injection.',
    scope: 'Only mutate the temporary e2e target repository.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  specs.set(created.runId, spec);
  h.developerWrites.set(created.runId, target.worktree);
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

test('C1: a blocking review triggers rework, then the run completes', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // reviewer blocks once, then passes -> developer reworks once.
    const { runId } = await startFeatureWithSpec(target, {
      // reviewer passes planning, blocks the first code review, then passes -> one rework.
      byRole: { reviewer: [{ kind: 'pass' }, { kind: 'verdict', verdict: 'blocker' }, { kind: 'pass' }] },
    });
    const terminal = await approveUntilTerminal(h.api, runId);
    assert.equal(terminal.state, 'completed');
    const developerRuns = executedRoles(h, runId).filter(([role]) => role === 'developer').length;
    assert.ok(developerRuns >= 2, `expected developer rework (>=2 runs), got ${developerRuns}`);
  } finally {
    target.cleanup();
  }
});

test('C2: a review that never passes blocks the pipeline at the iteration cap', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await startFeatureWithSpec(target, {
      byRole: { reviewer: { kind: 'verdict', verdict: 'blocker' } },
    });
    const terminal = await approveUntilTerminal(h.api, runId);
    assert.notEqual(terminal.state, 'completed', 'a never-passing review must not complete');
    await assertEventsPresent(h.api, runId, ['pipeline_blocked']);
    const detail = await h.api.getRun({ runId });
    assert.notEqual(detail.run.status, 'completed');
  } finally {
    target.cleanup();
  }
});

test('C3: a developer that throws reaches the retry gate and does not complete after give_up', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await startFeatureWithSpec(target, {
      byRole: { developer: { kind: 'throw', message: 'scripted developer crash' } },
    });
    const plan = await waitForGate(h.api, runId, 'plan');
    await h.api.resolveGate({ inboxId: plan.inboxId, outcome: 'approved', resolvedBy: 'e2e' });
    const retry = await waitForGate(h.api, runId, 'retry');
    await h.api.resolveGate({ inboxId: retry.inboxId, outcome: 'give_up', resolvedBy: 'e2e' });
    const terminal = await waitState(h.api, runId);
    assert.notEqual(terminal.state, 'completed', 'a crashing developer must not complete the run');
    await assertEventsPresent(h.api, runId, ['runner_retry_exhausted', 'pipeline_blocked']);
  } finally {
    target.cleanup();
  }
});

test('C4: markdown output without top-level verdict terminal-fails as invalid result', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await startFeatureWithSpec(target, {
      byRole: { reviewer: { kind: 'invalidNoVerdict', output: '# Review\napproved' } },
    });
    const terminal = await approveUntilTerminal(h.api, runId);
    assert.equal(terminal.state, 'failed', 'invalid agent result must terminal-fail');
    await assertEventsPresent(h.api, runId, ['step_failed']);
    const failures = await h.api.getRunEvents({ runId, type: 'run_failed' });
    const payload = failures.at(-1)?.payload as { reason?: string } | undefined;
    assert.match(payload?.reason ?? '', /revo\.ResultInvalid/);
  } finally {
    target.cleanup();
  }
});
