import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenInstalledPlaybook,
  createTargetRepo,
  type TargetRepo,
  type GhScenario,
  routedGhEmulator,
  routedIntegrator,
  type IntegratorOutcome,
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

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({
    gh: (ghCalls) => routedGhEmulator(ghScenarios, ghCalls),
    integrator: (base) => routedIntegrator(integratorOutcomes, base),
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
    playbookId: 'revisium-agent-playbook',
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
      playbookId: 'revisium-agent-playbook',
      pipelineId: 'feature-development',
      executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
      start: false,
    });
    h.developerWrites.set(created.runId, target.worktree);
    await h.api.startRun({ runId: created.runId });

    const terminal = await approveUntilTerminal(h.api, created.runId);
    assert.equal(terminal.state, 'completed');
    await assertEventsPresent(h.api, created.runId, ['integrate_succeeded', 'run_completed']);
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
