import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { worktreeMarkerFor, worktreePathFor } from '../control-plane/resolve-cwd.js';
import { branchName } from '../runners/integrator.js';
import type { RunAgent, AttemptResult } from '../worker/runner.js';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  PLAYBOOK_ID,
  createTargetRepo,
  type TargetRepo,
  type GhScenario,
  routedGhEmulator,
  routedIntegrator,
  type IntegratorOutcome,
  type AgentSink,
  resolveWriteDir,
  waitState,
  waitForGate,
  approveUntilTerminal,
  assertBlocked,
  assertLessonRedacted,
  assertNoRawTokenInEvents,
  assertGhNotCalled,
  assertEventsPresent,
  git,
} from './kit/index.js';

// Group D — integrator / git / gh failure modes, exercised through the REAL integrator + real git on
// a temp repo + a per-run gh emulator. One real host per file; gh outcomes routed by taskId.
let h: RunHarness;
const ghScenarios = new Map<string, GhScenario>();
const integratorOutcomes = new Map<string, IntegratorOutcome>(); // per-run mocked integrate results

// plan 0018 — per-run triage decisions (keyed by runId) the `triager` role emits. The emulator seeds a
// review thread id `PRRT_T1` (review-comment scenario); the triager decides fix/wontfix/question on it.
type TriageDecision = 'fix' | 'wontfix' | 'question';
const triageDecisions = new Map<string, TriageDecision[]>(); // a sequence so the question gate can re-triage

/**
 * A triager-aware test agent: the `triager` role returns a real `triage` object (so respondThreads
 * replies + resolves the emulator's seeded thread); every other role behaves like the deterministic
 * agent (developer writes a change so the integrator/CI-rework has a diff). plan 0018.
 */
function prReviewAgent(sink: AgentSink): RunAgent {
  const triageCounts = new Map<string, number>();
  return async ({ role, profile, attemptId, step, context }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    sink.agentCalls.push({ role: logicalRole, runner: role.runner, attemptId, runId: step.runId, context });
    const cost = [{ modelProfile: profile.level, currency: 'USD', inputTokens: 10, outputTokens: 5, costAmount: 0.001 }];
    if (logicalRole === 'triager') {
      const seq = triageDecisions.get(step.runId) ?? ['fix'];
      const n = triageCounts.get(step.runId) ?? 0;
      triageCounts.set(step.runId, n + 1);
      const decision = seq[Math.min(n, seq.length - 1)] ?? 'wontfix';
      // The emulator's review-comment scenario seeds exactly one unresolved thread, id PRRT_T1.
      const output = {
        items: [{ threadId: 'PRRT_T1', decision, guidance: 'address the review comment', replyText: 'done in the latest push' }],
        needsHuman: decision === 'question',
      };
      return { output, verdict: decision, nextSteps: [], costs: cost };
    }
    // developer writes a change file so the real integrator has a diff to commit/re-push. Plan 0017:
    // write into the run's ISOLATED worktree (resolveWriteDir parses Repo: from context, which build-context
    // sets to the worktree for live runs — slice 143), NOT the registered base checkout.
    const writeRepo = logicalRole === 'developer' ? resolveWriteDir(sink.developerWrites.get(step.runId), context) : undefined;
    if (writeRepo) writeFileSync(join(writeRepo, `developer-${attemptId}.txt`), `change from ${attemptId}\n`);
    return { output: { role: logicalRole }, verdict: logicalRole === 'watcher' ? 'clean' : 'approved', nextSteps: [], costs: cost };
  };
}

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({
    gh: (ghCalls) => routedGhEmulator(ghScenarios, ghCalls),
    integrator: (base) => routedIntegrator(integratorOutcomes, base),
    agent: (sink) => prReviewAgent(sink),
  });
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

/** Create + start a feature run; optionally pick its gh scenario, mocked integrate outcome, and whether the developer writes. */
async function startFeature(
  target: TargetRepo,
  opts: { gh?: GhScenario; integrate?: IntegratorOutcome; write?: boolean } = {},
): Promise<{ runId: string; taskId: string }> {
  const created = await h.api.createRun({
    repo: target.worktree,
    title: 'E2E integrator-failure feature run',
    description: 'Group D — integrator/git/gh failure injection.',
    scope: 'Only mutate the temporary e2e target repository.',
    playbookId: PLAYBOOK_ID,
    pipelineId: 'feature-development',
    executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent' } },
    start: false,
  });
  if (opts.gh) ghScenarios.set(created.taskId, opts.gh);
  if (opts.integrate) integratorOutcomes.set(created.taskId, opts.integrate);
  if (opts.write !== false) h.developerWrites.set(created.runId, target.worktree);
  await h.api.startRun({ runId: created.runId });
  return { runId: created.runId, taskId: created.taskId };
}

// ── Preflight and startup behavior ───────────────────────────────────────────

test('D3: a dirty target repo blocks at preflight', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ dirty: true });
  try {
    const run = await startFeature(target);
    await waitState(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D3b: a repaired preflight block resumes through a recovery child run', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ dirty: true });
  try {
    const run = await startFeature(target);
    let state = await waitState(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
    for (let waited = 0; waited < 8_000 && state.workflowStatus !== 'SUCCESS'; waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      state = await h.api.waitForRun({ runId: run.runId });
    }
    assert.equal(state.runStatus, 'paused');
    assert.equal(state.workflowStatus, 'SUCCESS');

    const blockedEvents = await h.api.getRunEvents({ runId: run.runId, type: 'pipeline_blocked', limit: 50 });
    const preflightEvent = blockedEvents.at(-1);
    assert.ok(preflightEvent, 'preflight block must emit pipeline_blocked');
    assert.equal((preflightEvent.payload as { reason?: unknown }).reason, 'preflight');

    rmSync(join(target.worktree, 'dirty.txt'), { force: true });
    const explicitStart = await h.api.startRun({ runId: run.runId });
    assert.equal((explicitStart as { recoverable?: unknown }).recoverable, true);
    assert.equal((explicitStart as { retryStarted?: unknown }).retryStarted, false);
    assert.equal((explicitStart as { nextAction?: unknown }).nextAction, 'resume_run');

    const resumed = await h.api.resumeRun({ runId: run.runId }) as {
      runId: string;
      workflowID: string;
      recovery: { parentRunId: string; recoveryRunId: string; blockedEventId: string; reason: string };
    };
    const recoveryRunId = resumed.runId;
    assert.notEqual(recoveryRunId, run.runId);
    assert.equal(resumed.workflowID, recoveryRunId);
    assert.equal(resumed.recovery.parentRunId, run.runId);
    assert.equal(resumed.recovery.recoveryRunId, recoveryRunId);
    assert.equal(resumed.recovery.blockedEventId, preflightEvent.eventId);
    assert.equal(resumed.recovery.reason, 'preflight');

    const resumedAgain = await h.api.resumeRun({ runId: run.runId }) as { runId: string };
    assert.equal(resumedAgain.runId, recoveryRunId, 'second resume must reuse the recovery child');

    h.developerWrites.set(recoveryRunId, target.worktree);
    await waitForGate(h.api, recoveryRunId, 'plan');
    const terminal = await approveUntilTerminal(h.api, recoveryRunId);
    assert.equal(terminal.state, 'completed');

    const parentEvents = await h.api.getRunEvents({ runId: run.runId, limit: 500 });
    const childEvents = await h.api.getRunEvents({ runId: recoveryRunId, limit: 500 });
    const parentLineage = parentEvents.find((event) => event.type === 'run_recovery_created');
    const childLineage = childEvents.find((event) => event.type === 'run_recovery_parent');
    assert.ok(parentLineage, 'parent run_recovery_created event must exist');
    assert.ok(childLineage, 'child run_recovery_parent event must exist');
    assert.deepEqual(parentLineage.payload, childLineage.payload);
  } finally {
    target.cleanup();
  }
});

test('D4: a stale feature caller starts live from fresh origin/master without switching caller', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ staleBranch: true });
  try {
    const run = await startFeature(target);
    await waitForGate(h.api, run.runId, 'plan');

    const wtPath = worktreePathFor(getConfig().dataDir, run.runId);
    assert.ok(existsSync(wtPath), `live run worktree must exist at ${wtPath}`);
    assert.ok(existsSync(worktreeMarkerFor(getConfig().dataDir, run.runId)), 'live worktree marker must exist');

    const expectedBranch = branchName(run.taskId, 'E2E integrator-failure feature run');
    assert.equal(git(wtPath, ['branch', '--show-current']).trim(), expectedBranch);
    assert.equal(
      git(wtPath, ['rev-parse', 'HEAD']).trim(),
      git(wtPath, ['rev-parse', 'origin/master']).trim(),
      'execution worktree starts at fresh origin/master',
    );
    assert.ok(existsSync(join(wtPath, 'moved.txt')), 'execution worktree must include the advanced origin/master commit');

    assert.equal(git(target.worktree, ['branch', '--show-current']).trim(), 'stale-feature');
    assert.equal(git(target.worktree, ['status', '--porcelain']).trim(), '', 'caller checkout remains clean');

    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed');
    assert.equal(git(target.worktree, ['branch', '--show-current']).trim(), 'stale-feature');
    assert.equal(git(target.worktree, ['status', '--porcelain']).trim(), '', 'caller checkout stays clean through completion');
  } finally {
    target.cleanup();
  }
});

test('D5: a base branch ahead of origin/master blocks at preflight', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ baseAhead: true });
  try {
    const run = await startFeature(target);
    await waitState(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

// ── Integrate failures (block after the plan gate, before merge) ─────────────

test('D11: nothing to integrate (no developer change) blocks at integrate', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { write: false });
    await approveUntilTerminal(h.api, run.runId); // approve plan; run then blocks at integrate
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D9: ambiguous open PRs block at integrate', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'ambiguous-prs' });
    await approveUntilTerminal(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D10: a non-JSON `pr view` after create blocks at integrate (never a stub PR)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'pr-view-non-json' });
    await approveUntilTerminal(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D20: confirmMerge blocks when the PR is not auto-mergeable — run blocked, worktree KEPT (plan 0017)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // gh reports the PR OPEN but mergeStateStatus≠CLEAN (red CI / conflicts) → confirmMerge refuses to
    // auto-merge and blocks; both gates are approved on the way there.
    const run = await startFeature(target, { gh: 'merge-not-clean' });
    await approveUntilTerminal(h.api, run.runId); // approve plan + merge; confirmMerge then blocks
    await assertBlocked(h.api, run.runId);
    await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'pipeline_blocked']);
    // The worktree is KEPT (NOT released) on a blocked terminal so the human can rework / merge manually.
    assert.ok(
      existsSync(worktreePathFor(getConfig().dataDir, run.runId)),
      'worktree must survive a confirm-merge block for rework',
    );
  } finally {
    target.cleanup();
  }
});

// ── Replay / idempotency ─────────────────────────────────────────────────────

test('D2: an existing open PR is reused (no duplicate create); run completes', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'pr-already-exists' });
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed');
    await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'run_completed']);
    assertGhNotCalled(h, run.taskId, ['pr', 'create']);
  } finally {
    target.cleanup();
  }
});

test('D6: a base branch missing on the remote blocks at preflight', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ baseMissing: true });
  try {
    const run = await startFeature(target);
    await waitState(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D8: a non-github origin remote blocks at integrate (unparseable owner/repo)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ nonGithubRemote: true });
  try {
    const run = await startFeature(target);
    await approveUntilTerminal(h.api, run.runId); // preflight ok; integrate can't parse the remote
    await assertBlocked(h.api, run.runId);
  } finally {
    target.cleanup();
  }
});

test('D14: a gh error during integrate fails the run (throw → failRun, never a silent pass)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'gh-error' });
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'failed'); // integrate throws → workflow catch → failRun
    await assertEventsPresent(h.api, run.runId, ['run_failed']);
  } finally {
    target.cleanup();
  }
});

test('D16: a stub (script-mode) integrator completes with no git/gh', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const created = await h.api.createRun({
      repo: target.worktree,
      title: 'E2E stub-integrator feature run',
      description: 'Group D — integrator overridden to a stub (script mode).',
      scope: 'Only mutate the temporary e2e target repository.',
      playbookId: PLAYBOOK_ID,
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await h.api.startRun({ runId: created.runId });

    const terminal = await approveUntilTerminal(h.api, created.runId);
    assert.equal(terminal.state, 'completed');
    // Stub path: integrator(stub)→pollPr(stub clean)→merge gate→confirmMerge(stub). `merge_confirmed` is
    // the deterministic "it merged" signal; `run_completed` is implied by terminal.state and races on the
    // fast stub path (status flips before the terminal event read), so assert the durable signals.
    await assertEventsPresent(h.api, created.runId, ['integrate_succeeded', 'merge_confirmed']);
    assertGhNotCalled(h, created.taskId, ['pr', 'list']);
    assertGhNotCalled(h, created.taskId, ['pr', 'create']);
  } finally {
    target.cleanup();
  }
});

// ── Mocked integrate outcomes (external git/gh boundary faked; workflow real) ─
// D7/D13/D15 inject the integrator's RESULT — the external boundary is exactly what we mock — and
// assert the workflow's handling: needsHuman → block + surface the reason; throw → failRun; a token
// in a surfaced lesson → redacted at the persist boundary.

test('D7: an unresolved pinned gh account fails loud (refuses ambient) → blocks and surfaces why', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, {
      integrate: {
        kind: 'needsHuman',
        lesson:
          "could not resolve a token for the pinned gh account 'revisium-io'; REFUSING to fall back to the ambient gh account",
      },
    });
    await approveUntilTerminal(h.api, run.runId); // preflight ok; integrate refuses → block (never falls back)
    await assertBlocked(h.api, run.runId);
    const events = await h.api.getRunEvents({ runId: run.runId, limit: 50 });
    const lesson = String(
      (events.find((e) => e.type === 'pipeline_blocked')?.payload as { lesson?: unknown } | undefined)?.lesson ?? '',
    );
    assert.match(lesson, /REFUSING to fall back/, 'the fail-loud reason must surface to the human verbatim');
  } finally {
    target.cleanup();
  }
});

test('D13: a push rejection during integrate fails the run (throw → failRun)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, {
      integrate: { kind: 'throw', message: 'git push rejected: non-fast-forward (remote moved); integrate aborted' },
    });
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'failed'); // integrate throws → workflow's top-level catch → failRun
    await assertEventsPresent(h.api, run.runId, ['run_failed']);
  } finally {
    target.cleanup();
  }
});

test('D15: a token in an integrator lesson is redacted before it is persisted/surfaced', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  const rawToken = 'gho_abcdEFGH1234567890LEAK'; // gho_ + 22 alnum → matches the token shape
  try {
    const run = await startFeature(target, {
      integrate: {
        kind: 'needsHuman',
        lesson: `gh push failed: bad credentials using token ${rawToken} rejected by server`,
      },
    });
    await approveUntilTerminal(h.api, run.runId); // integrate → needsHuman carrying a token → block
    await assertBlocked(h.api, run.runId);
    await assertLessonRedacted(h.api, run.runId, rawToken);
  } finally {
    target.cleanup();
  }
});

test('D19: a token in a gh error reaches no persisted event; the run fails redacted (failRun path)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'gh-token-leak' });
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'failed'); // gh throws during integrate → integrate throws → failRun
    await assertEventsPresent(h.api, run.runId, ['run_failed']);
    await assertNoRawTokenInEvents(h.api, run.runId, 'gho_abcdEFGH1234567890LEAK');
  } finally {
    target.cleanup();
  }
});

// ── #240 — pollPr mergeability gate ─────────────────────────────────────────

test('D35: merge conflict during pollPr → run blocked with mergeStateStatus=DIRTY in lesson', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // gh reports checks green, no review threads, but mergeStateStatus=DIRTY, mergeable=CONFLICTING.
    // Before #240, pollPr would false-clean and proceed to confirmMerge; after #240 it must block.
    const run = await startFeature(target, { gh: 'merge-conflict' });
    await approveUntilTerminal(h.api, run.runId); // approve plan gate; pollPr then blocks
    await assertBlocked(h.api, run.runId);
    const events = await h.api.getRunEvents({ runId: run.runId, limit: 50 });
    const blockedEvent = events.find((e) => e.type === 'pipeline_blocked');
    assert.ok(blockedEvent, 'a pipeline_blocked event must fire for a merge-conflict run');
    const payload = blockedEvent?.payload as { reason?: string; lesson?: string } | undefined;
    assert.equal(payload?.reason, 'poll-pr', 'blocked reason must be poll-pr');
    const lesson = String(payload?.lesson ?? '');
    assert.ok(lesson.includes('mergeStateStatus=DIRTY'), `lesson must name DIRTY mergeStateStatus; got: ${lesson}`);
    await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'pipeline_blocked']);
  } finally {
    target.cleanup();
  }
});

// ── plan 0018 — the PR review-feedback loop (pollPr → triage → fix/reply/resolve → merge) ─────────────

test('D30: CI-red → developer fixes → green → merge (pollPr ci_changes → ciRework → re-integrate → clean)', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // First poll sees a FAILING check (ci_changes) → the developer reworks → the integrator re-pushes →
    // the second poll is green (the emulator flips ci-red-then-green after the first view) → merge.
    const run = await startFeature(target, { gh: 'ci-red-then-green' });
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed', 'a CI failure is fixed and the run merges');
    await assertEventsPresent(h.api, run.runId, ['integrate_succeeded', 'pr_polled', 'merge_confirmed', 'run_completed']);
  } finally {
    target.cleanup();
  }
});

test('D31: review-comment → triage(fix) → developer → reply+resolve → merge', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // The first poll reports one unresolved review thread (review_changes) → triage decides `fix` → the
    // developer reworks → the integrator re-pushes → respondThreads replies + RESOLVES the thread (the
    // emulator drops it from the unresolved set) → the next poll is clean → merge.
    const run = await startFeature(target, { gh: 'review-comment' });
    triageDecisions.set(run.runId, ['fix']);
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed', 'a fixed review thread is replied/resolved and the run merges');
    await assertEventsPresent(h.api, run.runId, ['pr_polled', 'threads_responded', 'merge_confirmed', 'run_completed']);
  } finally {
    target.cleanup();
  }
});

test('D32: review-comment → triage(wontfix) → reply+resolve (no re-push) → merge', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // `wontfix` auto-resolves with the analyst's reason — no developer re-push — then the next poll is
    // clean (the thread was resolved) → merge.
    const run = await startFeature(target, { gh: 'review-comment' });
    triageDecisions.set(run.runId, ['wontfix']);
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed', 'a wontfix thread is replied/resolved and the run merges');
    await assertEventsPresent(h.api, run.runId, ['pr_polled', 'threads_responded', 'merge_confirmed', 'run_completed']);
  } finally {
    target.cleanup();
  }
});

test('D33: review-comment → triage(question) → questionGate(approve) → triage(wontfix) → merge', { skip: e2eSkip }, async () => {
  const target = createTargetRepo();
  try {
    // The first triage marks the thread a `question` → the SEPARATE review-question gate fires; on
    // approve the run re-triages (now `wontfix`) → reply+resolve → clean → merge. approveUntilTerminal
    // approves the plan, the review-question, and the merge gates in order.
    const run = await startFeature(target, { gh: 'review-comment' });
    triageDecisions.set(run.runId, ['question', 'wontfix']);
    const terminal = await approveUntilTerminal(h.api, run.runId);
    assert.equal(terminal.state, 'completed', 'a question is answered at the gate, then the thread is resolved and merged');
    await assertEventsPresent(h.api, run.runId, ['pr_polled', 'threads_responded', 'merge_confirmed', 'run_completed']);
  } finally {
    target.cleanup();
  }
});

// ── Anti-masking regression: developer writes to the GIVEN worktree (slice-143 / #130) ────────────
// D22: asserts that resolveWriteDir parses the Repo: path from context (the worktree for live runs)
// rather than recomputing it from runId. If build-context ever stops pointing Repo: at the worktree,
// the developer writes to the base checkout → worktree empty → integrate blocks with the slice-143
// lesson → these assertions fail and catch the regression.

test('D22: developer writes to the GIVEN worktree (Repo: from context); branch is ahead of base', { skip: e2eSkip }, async () => {
  // Use `merge-not-clean` so confirmMerge blocks AFTER integrate — the worktree is KEPT for inspection.
  const target = createTargetRepo();
  try {
    const run = await startFeature(target, { gh: 'merge-not-clean' });
    await approveUntilTerminal(h.api, run.runId); // approve plan + merge gate; confirmMerge then blocks
    await assertBlocked(h.api, run.runId);

    const wtPath = worktreePathFor(getConfig().dataDir, run.runId);

    // Assert 1: the developer's change file landed INSIDE the worktree (not the base checkout).
    const files = readdirSync(wtPath);
    const devFile = files.find((f) => /^developer-.*\.txt$/.test(f));
    assert.ok(devFile, `developer-*.txt must exist inside the worktree at ${wtPath} — got: ${files.join(', ')}`);

    // Assert 2: the worktree branch is ahead of base, proving the integrator committed from there.
    const branch = branchName(run.taskId, 'E2E integrator-failure feature run');
    const aheadStr = git(wtPath, ['rev-list', '--count', `origin/master..${branch}`]).trim();
    assert.ok(Number(aheadStr) > 0, `worktree branch must be ahead of origin/master (got ${aheadStr})`);
  } finally {
    target.cleanup();
  }
});
