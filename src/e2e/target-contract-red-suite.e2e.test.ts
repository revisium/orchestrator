import { after, test } from 'node:test';
import assert from 'node:assert/strict';
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
    });
    await givenSeededDefaultPlaybook(sharedHarness);
  }
  return sharedHarness;
}

async function runTargetScenario(title: string, scenario: Omit<PipelineScenario, 'title' | 'playbook' | 'repo'>): Promise<string[][]> {
  const target = createTargetRepo();
  const runCases = scenario.cleanup?.releaseWorktreeFails ? new Map<string, RunCase>() : sharedRunCases;
  const h = scenario.cleanup?.releaseWorktreeFails
    ? await createRunHarness({
        gh: (calls) => routedGhEmulator(runCases, calls),
        agent: (sink) => routedRunCaseAgent(runCases, sink),
        releaseWorktree: async () => { throw new Error('forced cleanup release failure'); },
      })
    : await targetHarness();
  try {
    if (scenario.cleanup?.releaseWorktreeFails) await givenSeededDefaultPlaybook(h);
    const ghCallStart = h.ghCalls.length;
    await pipelineScenario(h, runCases, { title, playbook: 'default', repo: target, ...scenario });
    return h.ghCalls.slice(ghCallStart);
  } finally {
    if (scenario.cleanup?.releaseWorktreeFails) await h.close();
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

test('#272: no registered checks are advisory and still reach mergeGate', {
  skip: '#272: pending zero-CI target behavior',
}, async () => {
  await runTargetScenario('#272: no registered checks are advisory and still reach mergeGate', {
    executionProfile: STUB_AGENT,
    gh: 'no-checks-registered',
    gates: [['plan', 'approved'], ['merge', 'cancel']],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
      noEvents: ['pipeline_blocked', 'merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', {
  skip: '#272: pending bounded recheck-loop target behavior',
}, async () => {
  await runTargetScenario('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', {
    executionProfile: STUB_AGENT,
    gh: 'checks-never-settle',
    gates: [['plan', 'approved'], ['merge', 'cancel']],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }],
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#273: externally merged PR completes through cleanup without recovery or merge attempt', {
  skip: '#273: pending externally merged PR target routing',
}, async () => {
  await runTargetScenario('#273: externally merged PR completes through cleanup without recovery or merge attempt', {
    executionProfile: STUB_AGENT,
    gh: 'merged-externally',
    gates: [['plan', 'approved']],
    expect: {
      terminal: 'completed',
      path: [{ type: 'pr_polled', payload: { verdict: 'merged' } }, 'worktree_released', 'run_completed'],
      noEvents: ['pipeline_blocked'],
      ghCalled: [
        ['pr', 'list', '--state', 'open'],
        ['pr', 'list', '--state', 'all'],
      ],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', {
  skip: '#273: pending externally closed PR target routing',
}, async () => {
  await runTargetScenario('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', {
    executionProfile: STUB_AGENT,
    gh: 'closed-externally',
    gates: [['plan', 'approved'], ['merge', 'cancel']],
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

test('#274: head moved after merge approval re-presents mergeGate with fresh artifact', {
  skip: '#274: pending merge approval headSha pinning',
}, async () => {
  await runTargetScenario('#274: head moved after merge approval re-presents mergeGate with fresh artifact', {
    executionProfile: STUB_AGENT,
    gh: 'head-moved-after-approve',
    gates: [['plan', 'approved'], ['merge', 'approved'], ['merge', 'cancel']],
    expect: {
      terminal: 'cancelled',
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#275: GraphQL partial outage is never treated as clean readiness', {
  skip: '#275: pending GraphQL partial-outage target behavior',
}, async () => {
  await runTargetScenario('#275: GraphQL partial outage is never treated as clean readiness', {
    executionProfile: STUB_AGENT,
    gh: 'empty-graphql-data',
    gates: [['plan', 'approved'], ['merge', 'cancel']],
    expect: {
      terminal: 'cancelled',
      noEvents: ['merge_confirmed'],
      ghNotCalled: [['pr', 'merge']],
    },
  });
});

test('#276: questionGate fix routes to review rework and resolves threads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose fix because the review catches a real defect';
  const calls = await runTargetScenario('#276: questionGate fix routes to review rework and resolves threads with the human reason', {
    executionProfile: STUB_AGENT,
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      ['plan', 'approved'],
      { topic: 'question', outcome: 'fix', note },
      ['merge', 'approved'],
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
    },
  });
  assertReviewReplyIncludes(calls, note);
});

test('#276: questionGate wontfix routes directly to respondThreads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose wontfix because the requested change is out of scope';
  const calls = await runTargetScenario('#276: questionGate wontfix routes directly to respondThreads with the human reason', {
    executionProfile: STUB_AGENT,
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      ['plan', 'approved'],
      { topic: 'question', outcome: 'wontfix', note },
      ['merge', 'approved'],
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
    },
  });
  assertReviewReplyIncludes(calls, note);
});

test('#277: cleanupWorktree failure after successful merge completes with cleanup_failed event', {
  skip: '#277: pending cleanup failure target routing',
}, async () => {
  await runTargetScenario('#277: cleanupWorktree failure after successful merge completes with cleanup_failed event', {
    executionProfile: STUB_AGENT,
    gh: 'happy',
    cleanup: { releaseWorktreeFails: true },
    gates: [['plan', 'approved'], ['merge', 'approved']],
    expect: {
      terminal: 'completed',
      path: ['merge_confirmed', 'cleanup_failed', 'run_completed'],
      noEvents: ['pipeline_blocked'],
    },
  });
});

test('#279: override_merge over advisory review threads replies, resolves, audits, and merges', {
  skip: '#279: pending force-merge target behavior',
}, async () => {
  await runTargetScenario('#279: override_merge over advisory review threads replies, resolves, audits, and merges', {
    executionProfile: STUB_AGENT,
    gh: 'force-advisory-thread',
    gates: [
      ['plan', 'approved'],
      {
        topic: 'merge',
        outcome: 'override_merge',
        mergeOverrideAudit: {
          threadIds: ['PRRT_T1'],
          actor: 'e2e',
          reason: 'force merge target contract: advisory review thread accepted',
          risk: 'synthetic e2e target contract',
          verificationResponsibility: 'e2e',
          headSha: 'deadbeefcafe',
        },
      },
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed', 'run_completed'],
    },
  });
});
