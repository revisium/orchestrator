import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { worktreePathFor } from '../control-plane/resolve-cwd.js';
import {
  createRunHarness,
  createTargetRepo,
  e2eSkip,
  givenSeededDefaultPlaybook,
  pipelineScenario,
  routedGhEmulator,
  routedRunCaseAgent,
  type PipelineScenario,
  type RunCase,
  type RunHarness,
} from './kit/index.js';
import { coverageForScenario, type PipelineScenarioCoverage } from '../control-plane/pipeline-coverage-registry.js';

const STUB_AGENT = { runnerOverrides: { 'claude-code': 'stub-agent' } };
let sharedHarness: RunHarness | undefined;
const sharedRunCases = new Map<string, RunCase>();

after(async () => {
  if (sharedHarness) await sharedHarness.close();
});

async function targetHarness(): Promise<RunHarness> {
  if (!sharedHarness) {
    sharedHarness = await createRunHarness({
      gh: (calls) => routedGhEmulator(sharedRunCases, calls),
      agent: (sink) => routedRunCaseAgent(sharedRunCases, sink),
      releaseWorktree: async (runId, taskId, baseRelease) => {
        const cleanup = sharedRunCases.get(runId)?.cleanup;
        if (cleanup?.releaseWorktreeFails) {
          throw new Error('forced cleanup release failure');
        }
        if (cleanup?.dirtyWorktreeBeforeRelease) {
          const worktreePath = worktreePathFor(getConfig().dataDir, runId);
          writeFileSync(join(worktreePath, 'dirty-before-release.txt'), 'preserve worktree\n', 'utf8');
        }
        return baseRelease(runId, taskId);
      },
    });
    await givenSeededDefaultPlaybook(sharedHarness);
  }
  return sharedHarness;
}

async function runTargetScenario(
  title: string,
  coverage: PipelineScenarioCoverage,
  scenario: Omit<PipelineScenario, 'title' | 'playbook' | 'repo' | 'coverage'>,
): Promise<string[][]> {
  const target = createTargetRepo();
  const runCases = sharedRunCases;
  const h = await targetHarness();
  try {
    const ghCallStart = h.ghCalls.length;
    await pipelineScenario(h, runCases, { title, playbook: 'default', repo: target, coverage, ...scenario });
    return h.ghCalls.slice(ghCallStart);
  } finally {
    target.cleanup();
  }
}

function assertReviewReplyIncludes(calls: string[][], expected: string): void {
  const bodies = calls
    .filter((args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => arg.includes('addPullRequestReviewThreadReply')))
    .map((args) => args.find((arg) => arg.startsWith('body='))?.slice('body='.length) ?? '');
  assert.ok(
    bodies.some((body) => body.includes(expected)),
    `expected a review-thread reply body to include ${JSON.stringify(expected)}; got ${JSON.stringify(bodies)}`,
  );
}

test('#272: no registered checks are advisory and still reach mergeGate', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: no registered checks are advisory and still reach mergeGate', coverageForScenario('TC-272-no-checks-clean'), {
    executionProfile: STUB_AGENT,
    gh: 'no-checks-registered',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'cancel', nodeId: 'mergeGate', summaryIncludes: ['checks: none registered'] },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
      noEvents: ['pipeline_blocked', 'merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', coverageForScenario('TC-272-never-settling-recovery'), {
    executionProfile: STUB_AGENT,
    gh: 'checks-never-settle',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }],
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#272: unclassifiable poll state routes through classifyRecovery to recoveryGate', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: unclassifiable poll state routes through classifyRecovery to recoveryGate', coverageForScenario('TC-272-unclassifiable-recovery'), {
    executionProfile: STUB_AGENT,
    gh: 'nonsense-poll-state',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      agentNodeCalled: ['classifyRecovery'],
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#273: externally merged PR completes through cleanup without recovery or merge attempt', { skip: e2eSkip }, async () => {
  await runTargetScenario('#273: externally merged PR completes through cleanup without recovery or merge attempt', coverageForScenario('TC-273-externally-merged'), {
    executionProfile: STUB_AGENT,
    gh: 'merged-externally',
    gates: [['plan', 'approved']],
    expect: {
      terminal: 'completed',
      events: ['run_completed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'merged' } }, 'worktree_released'],
      noEvents: ['pipeline_blocked', 'merge_confirmed'],
      ghCalled: [
        ['pr', 'list', '--state', 'open'],
        ['pr', 'list', '--state', 'all'],
      ],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', { skip: e2eSkip }, async () => {
  await runTargetScenario('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', coverageForScenario('TC-273-externally-closed'), {
    executionProfile: STUB_AGENT,
    gh: 'closed-externally',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate', summaryIncludes: ['pr_closed_externally'] },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'closed' } }],
      noEvents: ['merge_confirmed'],
      ghCalled: [
        ['pr', 'list', '--state', 'open'],
        ['pr', 'list', '--state', 'all'],
      ],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#274: head moved after merge approval re-presents mergeGate with fresh artifact', { skip: e2eSkip }, async () => {
  await runTargetScenario('#274: head moved after merge approval re-presents mergeGate with fresh artifact', coverageForScenario('TC-274-head-moved-reopens-merge-gate'), {
    executionProfile: STUB_AGENT,
    gh: 'head-moved-after-approve',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate', artifactHeadSha: 'deadbeefcafe' },
      { topic: 'merge', outcome: 'cancel', nodeId: 'mergeGate', artifactHeadSha: 'feedfacecafe' },
    ],
    expect: {
      terminal: 'cancelled',
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#275: GraphQL partial outage routes to recovery instead of clean readiness', { skip: e2eSkip }, async () => {
  await runTargetScenario('#275: GraphQL partial outage is never treated as clean readiness', coverageForScenario('TC-275-graphql-outage-recovery'), {
    executionProfile: STUB_AGENT,
    gh: 'empty-graphql-data',
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'step_failed', payload: { error: 'invalid GraphQL shape in reviewThreads response: missing repository' } }],
      agentNodeCalled: ['classifyRecovery'],
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#276: questionGate fix routes to review rework and resolves threads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose fix because the review catches a real defect';
  const calls = await runTargetScenario('#276: questionGate fix routes to review rework and resolves threads with the human reason', coverageForScenario('TC-276-question-fix'), {
    executionProfile: STUB_AGENT,
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      ['plan', 'approved'],
      { topic: 'question', outcome: 'fix', note, nodeId: 'questionGate' },
      ['merge', 'approved'],
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'review_changes' } }, 'threads_responded'],
    },
  });
  assertReviewReplyIncludes(calls, note);
});

test('#276: questionGate wontfix routes directly to respondThreads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose wontfix because the requested change is out of scope';
  const calls = await runTargetScenario('#276: questionGate wontfix routes directly to respondThreads with the human reason', coverageForScenario('TC-276-question-wontfix'), {
    executionProfile: STUB_AGENT,
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      ['plan', 'approved'],
      { topic: 'question', outcome: 'wontfix', note, nodeId: 'questionGate' },
      ['merge', 'approved'],
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'review_changes' } }, 'threads_responded'],
    },
  });
  assertReviewReplyIncludes(calls, note);
});

test('#277: cleanupWorktree dirty preserve after successful merge completes with cleanup_failed event', { skip: e2eSkip }, async () => {
  await runTargetScenario('#277: cleanupWorktree dirty preserve after successful merge completes with cleanup_failed event', coverageForScenario('TC-277-cleanup-dirty-preserve'), {
    executionProfile: STUB_AGENT,
    gh: 'happy',
    cleanup: { dirtyWorktreeBeforeRelease: true },
    gates: [['plan', 'approved'], { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' }],
    expect: {
      terminal: 'completed',
      path: [
        'merge_confirmed',
        { type: 'cleanup_failed', payload: { reason: 'dirty', released: false } },
        'run_completed',
      ],
      noEvents: ['pipeline_blocked'],
    },
  });
});

test('#279: override_merge over advisory review threads replies, resolves, audits, and merges', {
  skip: e2eSkip,
}, async () => {
  const note = 'force merge target contract: advisory review thread accepted';
  const risk = 'synthetic e2e target contract';
  const verificationResponsibility = 'e2e';
  const calls = await runTargetScenario('#279: override_merge over advisory review threads replies, resolves, audits, and merges', coverageForScenario('TC-279-override-advisory-thread'), {
    executionProfile: STUB_AGENT,
    gh: 'force-advisory-thread',
    gates: [
      ['plan', 'approved'],
      {
        topic: 'merge',
        outcome: 'override_merge',
        nodeId: 'mergeGate',
        note,
        mergeOverrideAudit: {
          threadIds: ['PRRT_T1'],
          actor: 'e2e',
          reason: note,
          risk,
          verificationResponsibility,
          headSha: 'deadbeefcafe',
        },
      },
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_overridden', 'merge_confirmed', 'run_completed'],
      path: [{
        type: 'merge_overridden',
        payload: { actor: 'e2e', note, reason: note, risk, verificationResponsibility, headSha: 'deadbeefcafe', prNumber: 7 },
      }],
    },
  });
  assertReviewReplyIncludes(calls, `merged by operator override: ${note}`);
});
