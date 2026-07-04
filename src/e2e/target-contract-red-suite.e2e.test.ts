import { test } from 'node:test';
import {
  createRunHarness,
  createTargetRepo,
  givenSeededDefaultPlaybook,
  pipelineScenario,
  routedGhEmulator,
  routedRunCaseAgent,
  type PipelineScenario,
  type RunCase,
} from './kit/index.js';

const STUB_AGENT = { runnerOverrides: { 'claude-code': 'stub-agent' } };

async function runTargetScenario(title: string, scenario: Omit<PipelineScenario, 'title' | 'playbook' | 'repo'>): Promise<void> {
  const runCases = new Map<string, RunCase>();
  const target = createTargetRepo();
  const h = await createRunHarness({
    gh: (calls) => routedGhEmulator(runCases, calls),
    agent: (sink) => routedRunCaseAgent(runCases, sink),
    ...(scenario.cleanup?.releaseWorktreeFails
      ? { releaseWorktree: async () => { throw new Error('forced cleanup release failure'); } }
      : {}),
  });
  try {
    await givenSeededDefaultPlaybook(h);
    await pipelineScenario(h, runCases, { title, playbook: 'default', repo: target, ...scenario });
  } finally {
    await h.close();
    target.cleanup();
  }
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

test('#276: questionGate changes_requested routes to review rework and resolves threads', {
  skip: '#276: pending questionGate target routing',
}, async () => {
  await runTargetScenario('#276: questionGate changes_requested routes to review rework and resolves threads', {
    executionProfile: STUB_AGENT,
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question', 'wontfix'] } } },
    gates: [['plan', 'approved'], ['question', 'changes_requested'], ['merge', 'approved']],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
    },
  });
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
