import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
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
  approveUntilTerminal,
  assertBlocked,
  assertLessonRedacted,
  assertNoRawTokenInEvents,
  assertGhNotCalled,
  assertEventsPresent,
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
  return async ({ role, profile, attemptId, step }): Promise<AttemptResult> => {
    const logicalRole = role.playbookRoleId ?? role.name;
    sink.agentCalls.push({ role: logicalRole, runner: role.runner, attemptId, runId: step.runId, context: '' });
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
    // write into the run's ISOLATED worktree (resolveWriteDir), NOT the registered base checkout — the
    // integrator commits from the worktree, so a base-checkout write would leave it with no diff.
    const writeRepo = logicalRole === 'developer' ? resolveWriteDir(step.runId, sink.developerWrites.get(step.runId)) : undefined;
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

// ── Preflight failures (block before the plan gate) ──────────────────────────

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

test('D4: a feature branch not based on fresh origin/master blocks at preflight', { skip: e2eSkip }, async () => {
  const target = createTargetRepo({ staleBranch: true });
  try {
    const run = await startFeature(target);
    await waitState(h.api, run.runId);
    await assertBlocked(h.api, run.runId);
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
