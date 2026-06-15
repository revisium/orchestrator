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
  waitState,
  approveUntilTerminal,
  assertBlocked,
  assertGhNotCalled,
  assertEventsPresent,
} from './kit/index.js';

// Group D — integrator / git / gh failure modes, exercised through the REAL integrator + real git on
// a temp repo + a per-run gh emulator. One real host per file; gh outcomes routed by taskId.
let h: RunHarness;
const ghScenarios = new Map<string, GhScenario>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  h = await createRunHarness({ gh: (ghCalls) => routedGhEmulator(ghScenarios, ghCalls) });
  await givenInstalledPlaybook(h);
});

after(async () => {
  if (h) await h.close();
});

/** Create + start a feature run; optionally pick its gh scenario and whether the developer writes. */
async function startFeature(
  target: TargetRepo,
  opts: { gh?: GhScenario; write?: boolean } = {},
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
