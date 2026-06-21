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

test('C3: a developer that throws records step_failed and does not complete', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await startFeatureWithSpec(target, {
      byRole: { developer: { kind: 'throw', message: 'scripted developer crash' } },
    });
    const terminal = await approveUntilTerminal(h.api, runId);
    assert.notEqual(terminal.state, 'completed', 'a crashing developer must not complete the run');
    await assertEventsPresent(h.api, runId, ['step_failed']);
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

// GAP (always skipped — executable spec for a not-yet-built feature):
// Architecture invariant #5 says the inbox handles "approve / answer" and an answer signals the
// parked DBOS workflow to resume. Today only the plan/merge GATES are wired for park+resume; a role
// step's needsHuman merely marks the step `awaiting_approval` and the workflow continues (it does not
// pause for an answer). Un-skip once role-needsHuman is wired to pushInbox(question) + DBOS.recv/send.
// Tracked in 05-HYPOTHESES as H-AgentQuestionResume.
test('B (gap): an agent question parks the run; answering it resumes to completion', {
  skip: 'pending feature: agent-question resume not implemented (only plan/merge gates park+resume; invariant #5)',
}, async () => {
  const target = createTargetRepo();
  try {
    const { runId } = await startFeatureWithSpec(target, {
      byRole: { analyst: { kind: 'needsHuman', lesson: 'which auth provider should the feature use?' } },
    });
    // The run should park as a question the human can read…
    const parked = await waitState(h.api, runId);
    assert.equal(parked.state, 'question');
    const [question] = await h.api.getPendingDecisions(runId);
    assert.ok(question, 'a needs-human question must surface in the inbox');
    // …and answering it should resume the workflow with that answer, to completion.
    await h.api.answerQuestion({ inboxId: question.id, answer: { provider: 'oauth' } });
    const resumed = await approveUntilTerminal(h.api, runId);
    assert.equal(resumed.state, 'completed');
  } finally {
    target.cleanup();
  }
});
