import type { AttemptResult } from '../worker/runner.js';
import type { Step } from '../control-plane/steps.js';
import {
  collectPrReadiness,
  defaultExecGh,
  defaultFetchSonar,
  toFinitePositive,
  toReadinessInput,
  type ExecGhFn,
  type FetchSonarFn,
  type PollInput,
} from './pr-readiness-core.js';

export {
  defaultExecGh,
  defaultFetchSonar,
  GITHUB_CHECK_ROLLUP_UNAVAILABLE,
  type CiSummary,
  type ExecGhFn,
  type FetchSonarFn,
  type PollInput,
  type SonarResult,
} from './pr-readiness-core.js';

const DEFAULT_MAX_POLLS = 20;
const DEFAULT_POLL_INTERVAL_MS = 30_000;

function requeue(input: PollInput, step: Step, prNumber: number, pollIntervalMs: number): AttemptResult {
  return {
    output: { verdict: 'pending', poll_count: input.poll_count },
    nextSteps: [
      {
        role: 'ci-poller',
        kind: 'poll',
        input: { ...input, pr_number: prNumber, poll_count: input.poll_count + 1 },
        runAfter: new Date(Date.now() + pollIntervalMs).toISOString(),
        taskId: step.taskId,
        modelProfile: step.modelProfile,
      },
    ],
    costs: [],
  };
}

export async function run(
  input: PollInput,
  step: Step,
  execGh: ExecGhFn = defaultExecGh,
  fetchSonar: FetchSonarFn = defaultFetchSonar,
): Promise<AttemptResult> {
  const maxPolls = toFinitePositive(
    input.max_polls ?? process.env['MAX_POLLS'],
    DEFAULT_MAX_POLLS,
  );
  const pollIntervalMs = toFinitePositive(
    input.poll_interval_ms ?? process.env['POLL_INTERVAL_MS'],
    DEFAULT_POLL_INTERVAL_MS,
  );

  const readiness = await collectPrReadiness(toReadinessInput(input), execGh, fetchSonar);
  const prNumber = readiness.pr.number ?? input.pr_number;

  if (readiness.verdict === 'merged') {
    return { output: { verdict: 'merged', pr_number: prNumber }, nextSteps: [], costs: [] };
  }

  if (readiness.verdict === 'closed') {
    return {
      output: { verdict: 'closed', pr_number: prNumber },
      nextSteps: [],
      needsHuman: true,
      lesson: readiness.evidence[0] ?? 'PR was closed without merging - manual review needed',
      costs: [],
    };
  }

  if (readiness.nextAction === 'human_decision' && !prNumber) {
    return {
      output: { verdict: 'unresolved' },
      nextSteps: [],
      needsHuman: true,
      lesson: readiness.evidence[0] ?? 'Cannot identify a PR to watch',
      costs: [],
    };
  }

  if (readiness.pr.draft) {
    if (input.poll_count >= maxPolls) {
      return {
        output: { verdict: 'draft', poll_count: input.poll_count },
        nextSteps: [],
        needsHuman: true,
        lesson: `PR #${prNumber} is still a draft after ${input.poll_count} polls`,
        costs: [],
      };
    }
    return {
      ...requeue(input, step, prNumber ?? 0, pollIntervalMs),
      output: { verdict: 'draft', poll_count: input.poll_count },
    };
  }

  if (readiness.checks.pending.length > 0) {
    if (input.poll_count >= maxPolls) {
      const pendingNames = readiness.checks.pending;
      const lesson =
        `CI polling timed out after ${input.poll_count} polls - checks still pending or absent` +
        (pendingNames.length > 0 ? ` (pending: ${pendingNames.join(', ')})` : '');
      return {
        output: { verdict: 'timeout', poll_count: input.poll_count, checks: readiness.checks.list },
        nextSteps: [],
        needsHuman: true,
        lesson,
        costs: [],
      };
    }
    return requeue(input, step, prNumber ?? 0, pollIntervalMs);
  }

  return {
    output: { verdict: 'terminal', ci_passed: readiness.ciSummary.ci_passed },
    nextSteps: [
      {
        role: 'pr-watcher',
        kind: 'judge',
        input: readiness.ciSummary,
        taskId: step.taskId,
        modelProfile: step.modelProfile,
      },
    ],
    costs: [],
  };
}
