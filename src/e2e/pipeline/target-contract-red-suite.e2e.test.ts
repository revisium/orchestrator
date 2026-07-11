import { after, test } from 'node:test';
import { e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineCasePlan,
  type PipelineContext,
} from '../support/pipeline-context.js';
import {
  coverageForScenario,
  type PipelineScenarioCoverage,
} from '../../testing/policy/pipeline-coverage.js';

let sharedPipeline: PipelineContext | undefined;
const PLAN_OPTIONS = ['approved', 'rework', 'cancel'] as const;
const MERGE_OPTIONS = [
  'approved',
  'recheck',
  'address_review_threads',
  'return_to_development',
  'override_merge',
  'cancel',
] as const;
const RECOVERY_OPTIONS = ['recheck', 'cancel'] as const;
const QUESTION_OPTIONS = ['fix', 'wontfix', 'cancel'] as const;

after(async () => {
  if (sharedPipeline) await sharedPipeline.close();
});

async function targetPipeline(): Promise<PipelineContext> {
  sharedPipeline ??= await createPipelineContext();
  return sharedPipeline;
}

async function runTargetScenario(
  title: string,
  coverage: PipelineScenarioCoverage,
  scenario: Omit<PipelineCasePlan, 'title' | 'playbook' | 'repo' | 'coverage'>,
): Promise<void> {
  const pipeline = await targetPipeline();
  await pipeline.run({ title, playbook: 'default', repo: pipeline.target(), coverage, ...scenario });
}

test('#272: no registered checks are advisory and still reach mergeGate', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: no registered checks are advisory and still reach mergeGate', coverageForScenario('TC-272-no-checks-clean'), {
    gh: 'no-checks-registered',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: MERGE_OPTIONS,
        outcome: 'cancel',
        nodeId: 'mergeGate',
        summaryIncludes: ['checks: none registered'],
      },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
      noEvents: ['pipeline_blocked', 'merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: never-settling checks route to recoveryGate instead of spinning to MAX_STEPS', coverageForScenario('TC-272-never-settling-recovery'), {
    gh: 'checks-never-settle',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }],
      noEvents: ['merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#272: unclassifiable poll state routes through classifyRecovery to recoveryGate', { skip: e2eSkip }, async () => {
  await runTargetScenario('#272: unclassifiable poll state routes through classifyRecovery to recoveryGate', coverageForScenario('TC-272-unclassifiable-recovery'), {
    gh: 'nonsense-poll-state',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      agentNodeCalled: ['classifyRecovery'],
      noEvents: ['merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#273: externally merged PR completes through cleanup without recovery or merge attempt', { skip: e2eSkip }, async () => {
  await runTargetScenario('#273: externally merged PR completes through cleanup without recovery or merge attempt', coverageForScenario('TC-273-externally-merged'), {
    gh: 'merged-externally',
    gates: [{ topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' }],
    expect: {
      terminal: 'completed',
      events: ['run_completed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'merged' } }, 'worktree_released'],
      noEvents: ['pipeline_blocked', 'merge_confirmed'],
      sideEffects: ['list_open_pull_requests', 'list_all_pull_requests'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', { skip: e2eSkip }, async () => {
  await runTargetScenario('#273: externally closed unmerged PR reaches recoveryGate immediately with closed reason', coverageForScenario('TC-273-externally-closed'), {
    gh: 'closed-externally',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: RECOVERY_OPTIONS,
        outcome: 'cancel',
        nodeId: 'recoveryGate',
        summaryIncludes: ['pr_closed_externally'],
      },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'closed' } }],
      noEvents: ['merge_confirmed'],
      sideEffects: ['list_open_pull_requests', 'list_all_pull_requests'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#274: head moved after merge approval re-presents mergeGate with fresh artifact', { skip: e2eSkip }, async () => {
  await runTargetScenario('#274: head moved after merge approval re-presents mergeGate with fresh artifact', coverageForScenario('TC-274-head-moved-reopens-merge-gate'), {
    gh: 'head-moved-after-approve',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: MERGE_OPTIONS,
        outcome: 'approved',
        nodeId: 'mergeGate',
        artifactHeadSha: 'deadbeefcafe',
      },
      {
        topic: 'merge',
        options: MERGE_OPTIONS,
        outcome: 'cancel',
        nodeId: 'mergeGate',
        artifactHeadSha: 'feedfacecafe',
      },
    ],
    expect: {
      terminal: 'cancelled',
      noEvents: ['merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#275: GraphQL partial outage routes to recovery instead of clean readiness', { skip: e2eSkip }, async () => {
  await runTargetScenario('#275: GraphQL partial outage is never treated as clean readiness', coverageForScenario('TC-275-graphql-outage-recovery'), {
    gh: 'empty-graphql-data',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'step_failed', payload: { error: 'invalid GraphQL shape in reviewThreads response: missing repository' } }],
      agentNodeCalled: ['classifyRecovery'],
      noEvents: ['merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});

test('#276: questionGate fix routes to review rework and resolves threads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose fix because the review catches a real defect';
  await runTargetScenario('#276: questionGate fix routes to review rework and resolves threads with the human reason', coverageForScenario('TC-276-question-fix'), {
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'question', options: QUESTION_OPTIONS, outcome: 'fix', note, nodeId: 'questionGate' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'review_changes' } }, 'threads_responded'],
      reviewReplyIncludes: [note],
    },
  });
});

test('#276: questionGate wontfix routes directly to respondThreads with the human reason', {
  skip: e2eSkip,
}, async () => {
  const note = 'human chose wontfix because the requested change is out of scope';
  await runTargetScenario('#276: questionGate wontfix routes directly to respondThreads with the human reason', coverageForScenario('TC-276-question-wontfix'), {
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'question', options: QUESTION_OPTIONS, outcome: 'wontfix', note, nodeId: 'questionGate' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['threads_responded', 'merge_confirmed'],
      path: [{ type: 'pr_polled', payload: { verdict: 'review_changes' } }, 'threads_responded'],
      reviewReplyIncludes: [note],
    },
  });
});

test('#277: cleanupWorktree dirty preserve after successful merge completes with cleanup_failed event', { skip: e2eSkip }, async () => {
  await runTargetScenario('#277: cleanupWorktree dirty preserve after successful merge completes with cleanup_failed event', coverageForScenario('TC-277-cleanup-dirty-preserve'), {
    gh: 'happy',
    cleanup: { dirtyWorktreeBeforeRelease: true },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
    ],
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
  await runTargetScenario('#279: override_merge over advisory review threads replies, resolves, audits, and merges', coverageForScenario('TC-279-override-advisory-thread'), {
    gh: 'force-advisory-thread',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: MERGE_OPTIONS,
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
      reviewReplyIncludes: [`merged by operator override: ${note}`],
    },
  });
});
