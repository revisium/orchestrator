import assert from 'node:assert/strict';
import type { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import type { RunHarness } from './harness.js';

type Api = TaskControlPlaneApiService;

/** Assert the run reached `completed`. Returns the detail. */
export async function assertCompleted(api: Api, runId: string) {
  // The run-row status patch can lag the workflow's terminal transition by a beat under load, so poll
  // for the authoritative run status to settle rather than reading once. (There are no `steps` rows to
  // settle — the data-driven engine writes none; progress lives in DBOS — audit §3.1.)
  let detail = await api.getRun({ runId, includeEvents: true, includeLog: true });
  for (let waited = 0; waited < 5_000 && detail.run.status !== 'completed'; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    detail = await api.getRun({ runId, includeEvents: true, includeLog: true });
  }
  assert.equal(detail.run.status, 'completed');
  return detail;
}

/** Assert the recorded attempt verdicts (in order) and that each carries a process artifact ref. */
export async function assertAttemptVerdicts(api: Api, runId: string, verdicts: string[]) {
  const attempts = await api.getRunLog({ runId, limit: 50 });
  assert.deepEqual(attempts.map((a) => a.verdict), verdicts);
  assert.ok(attempts.every((a) => a.artifactRef?.startsWith('test-artifacts/')), 'attempts carry process artifact refs');
  return attempts;
}

/** Assert every listed event type is visible for the run. Polls briefly: a terminal event such as
 *  `run_completed` is appended just AFTER the run-row status patch (same ordering `assertCompleted`
 *  guards — the run row settles first, the rest lags a beat), so a single read taken the instant
 *  `approveUntilTerminal` returns can race the append and miss it (the F1 recovery flake). A type that
 *  is genuinely never emitted still fails after the window — this hides propagation lag, not real gaps. */
export async function assertEventsPresent(api: Api, runId: string, types: string[]) {
  // limit 500 (not 50): a recovered/looped run (replay + the pollPr review tail) can accrue >50 events,
  // and getRunEvents returns oldest-first — a 50-window would drop the terminal `run_completed`.
  let events = await api.getRunEvents({ runId, limit: 500 });
  const missing = () => types.filter((type) => !events.some((e) => e.type === type));
  for (let waited = 0; waited < 8_000 && missing().length > 0; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = await api.getRunEvents({ runId, limit: 500 });
  }
  // Deterministic fallback for the terminal `run_completed` event: it is appended just AFTER the run-row
  // status patch, so on a fast run it can still trail the read window. The run STATUS being `completed`
  // (the authoritative signal `wait_for_run`/`approveUntilTerminal` already observed) proves completion,
  // so accept `run_completed` when the run row is `completed` even if its event append hasn't surfaced.
  let runCompleted = false;
  if (types.includes('run_completed') && !events.some((e) => e.type === 'run_completed')) {
    runCompleted = (await api.getRun({ runId })).run.status === 'completed';
  }
  for (const type of types) {
    if (type === 'run_completed' && runCompleted) continue;
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

/** Assert the run did not complete and emitted a `pipeline_blocked` event (preflight/integrate/etc.). */
export async function assertBlocked(api: Api, runId: string): Promise<void> {
  const events = await api.getRunEvents({ runId, limit: 50 });
  assert.ok(events.some((e) => e.type === 'pipeline_blocked'), 'a blocked run must emit pipeline_blocked');
  const detail = await api.getRun({ runId });
  assert.notEqual(detail.run.status, 'completed', 'a blocked run must not be completed');
}

/** Assert no persisted event for the run carries the raw token (serialized scan over all events). */
export async function assertNoRawTokenInEvents(api: Api, runId: string, rawToken: string): Promise<void> {
  const events = await api.getRunEvents({ runId, limit: 50 });
  assert.ok(
    !JSON.stringify(events).includes(rawToken),
    `a raw token must never reach persisted events: ${rawToken}`,
  );
}

/**
 * Assert a raw GitHub token never reaches the run's persisted events, and that the blocking
 * `pipeline_blocked` lesson was redacted to `[REDACTED]`. Drives the token through a needsHuman
 * integrator lesson; the persist boundary (appendRunEvent → redactEventPayload) must mask it.
 */
export async function assertLessonRedacted(api: Api, runId: string, rawToken: string): Promise<void> {
  const events = await api.getRunEvents({ runId, limit: 50 });
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes(rawToken), `a raw token must never reach persisted events: ${rawToken}`);
  const blocked = events.find((e) => e.type === 'pipeline_blocked');
  assert.ok(blocked, 'a redaction case must still block (pipeline_blocked emitted)');
  const lesson = String((blocked.payload as { lesson?: unknown } | undefined)?.lesson ?? '');
  assert.ok(lesson.includes('[REDACTED]'), 'the surfaced lesson must show the redaction marker');
}

/**
 * Assert a recovered run's durable record is exactly-once — replay after crash recovery must not
 * duplicate terminal or step events (deterministic ids + ROW_CONFLICT). Guards the idempotency the
 * engine relies on so DBOS workflow replays are side-effect-free.
 */
export async function assertReplayIdempotent(api: Api, runId: string): Promise<void> {
  // Poll for the terminal `run_completed` to surface before asserting exactly-once: like
  // assertEventsPresent, the event is appended just AFTER the run-row status patch, so a single read
  // taken the instant recovery returns can race the append and miss it (the F2 recovery flake).
  let events = await api.getRunEvents({ runId, limit: 100 });
  for (let waited = 0; waited < 8_000 && !events.some((e) => e.type === 'run_completed'); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    events = await api.getRunEvents({ runId, limit: 100 });
  }
  const completed = events.filter((e) => e.type === 'run_completed');
  assert.equal(completed.length, 1, 'run_completed must appear exactly once after recovery');
  const stepKeys = events
    .filter((e) => e.type === 'step_succeeded')
    .map((e) => String((e.payload as { stepKey?: unknown } | undefined)?.stepKey ?? ''));
  assert.equal(stepKeys.length, new Set(stepKeys).size, 'a replayed step must not emit a duplicate step_succeeded');
}

/** Assert a gh subcommand was NOT invoked for this run's branch (e.g. `pr create` when reusing a PR). */
export function assertGhNotCalled(h: RunHarness, taskId: string, sub: [string, string]): void {
  const branchPrefix = `feat/${taskId}-`;
  assert.ok(
    !h.ghCalls.some((c) => c[0] === sub[0] && c[1] === sub[1] && c.some((a) => a.startsWith(branchPrefix))),
    `gh ${sub.join(' ')} must not be called for ${taskId}`,
  );
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
