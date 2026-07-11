import { after, before, test } from 'node:test';
import {
  nonDslPipelineCaseAttachment,
  type PipelineNonDslCaseId,
} from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineCasePlan,
  type PipelineContext,
} from '../support/pipeline-context.js';

let pipeline: PipelineContext;
const PLAN_OPTIONS = ['approved'] as const;
const MERGE_OPTIONS = ['approved', 'recheck', 'override_merge', 'cancel'] as const;
const RECOVERY_OPTIONS = ['recheck', 'cancel'] as const;
const QUESTION_OPTIONS = ['fix', 'wontfix', 'cancel'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

async function runCase(
  caseId: PipelineNonDslCaseId,
  title: string,
  plan: Omit<PipelineCasePlan, 'title' | 'repo' | 'coverage'>,
): Promise<void> {
  await pipeline.run({
    title,
    repo: pipeline.target(),
    coverage: nonDslPipelineCaseAttachment(caseId),
    ...plan,
  });
}

test('D11: no produced change opens recovery and can cancel', { skip: e2eSkip }, async () => {
  await runCase('D11', 'D11: nothing to integrate', {
    developerWrite: false,
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: RECOVERY_OPTIONS,
        outcome: 'cancel',
        nodeId: 'recoveryGate',
      },
    ],
    expect: { terminal: 'cancelled', noEvents: ['merge_confirmed'] },
  });
});

for (const [caseId, gh, summary] of [
  ['D9', 'ambiguous-prs', 'Ambiguous:'],
  ['D10', 'pr-view-non-json', 'JSON'],
] as const) {
  test(`${caseId}: integration ambiguity routes to recovery`, { skip: e2eSkip }, async () => {
    await runCase(caseId, `${caseId}: integration recovery`, {
      gh,
      gates: [
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        {
          topic: 'merge',
          options: RECOVERY_OPTIONS,
          outcome: 'cancel',
          nodeId: 'recoveryGate',
          summaryIncludes: [summary],
        },
      ],
      expect: { terminal: 'cancelled', noEvents: ['merge_confirmed'] },
    });
  });
}

test('D20 pipeline: confirm-merge refusal routes through recovery to cancellation', { skip: e2eSkip }, async () => {
  await runCase('D20', 'D20: confirm merge recovery route', {
    gh: 'merge-not-clean',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: {
      terminal: 'cancelled',
      events: ['integrate_succeeded', 'pipeline_blocked'],
      blockedDecision: {
        reason: 'confirm-merge',
        lessonIncludes: ['mergeStateStatus=BLOCKED'],
      },
      noEvents: ['merge_confirmed'],
    },
  });
});

test('D2: an existing open PR is reused without duplicate creation', { skip: e2eSkip }, async () => {
  await runCase('D2', 'D2: reuse existing PR', {
    gh: 'pr-already-exists',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['integrate_succeeded', 'run_completed'],
      forbiddenSideEffects: ['create_pull_request'],
    },
  });
});

test('D14: GitHub failure opens recovery with recheck and cancel outcomes', { skip: e2eSkip }, async () => {
  await runCase('D14', 'D14: GitHub failure recovery', {
    gh: 'gh-error',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: RECOVERY_OPTIONS,
        outcome: 'cancel',
        nodeId: 'recoveryGate',
      },
    ],
    expect: { terminal: 'cancelled' },
  });
});

test('D14b: PR-ready failure exposes an actionable recovery lesson', { skip: e2eSkip }, async () => {
  await runCase('D14b', 'D14b: PR ready failure recovery', {
    gh: 'ready-fails',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'merge',
        options: RECOVERY_OPTIONS,
        outcome: 'cancel',
        nodeId: 'recoveryGate',
        summaryIncludes: ['failed to mark PR #7 ready for review', 'permission denied'],
      },
    ],
    expect: { terminal: 'cancelled' },
  });
});

test('D7: unresolved pinned GitHub identity fails loud without ambient fallback', { skip: e2eSkip }, async () => {
  await runCase('D7', 'D7: pinned GitHub identity failure', {
    integrator: {
      kind: 'needsHuman',
      lesson: "could not resolve a token for the pinned gh account 'profile-bot'; REFUSING to fall back to the ambient gh account",
    },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: {
      terminal: 'cancelled',
      blockedDecision: {
        reason: 'integrate',
        lessonIncludes: ['REFUSING to fall back'],
      },
    },
  });
});

test('D13: push rejection routes through recovery to cancellation', { skip: e2eSkip }, async () => {
  await runCase('D13', 'D13: push rejection', {
    integrator: { kind: 'throw', message: 'git push rejected: non-fast-forward (remote moved); integrate aborted' },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: { terminal: 'cancelled', noEvents: ['run_completed'] },
  });
});

test('D15: an integrator lesson token is redacted before persistence', { skip: e2eSkip }, async () => {
  const rawToken = 'gho_abcdEFGH1234567890LEAK';
  await runCase('D15', 'D15: integrator lesson redaction', {
    integrator: {
      kind: 'needsHuman',
      lesson: `gh push failed: bad credentials using token ${rawToken} rejected by server`,
    },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: {
      terminal: 'cancelled',
      persistedDataExcludes: [rawToken],
      blockedDecision: {
        reason: 'integrate',
        lessonIncludes: ['[REDACTED]'],
      },
    },
  });
});

test('D19: a token from a GitHub failure never reaches persisted events', { skip: e2eSkip }, async () => {
  const rawToken = 'gho_abcdEFGH1234567890LEAK';
  await runCase('D19', 'D19: GitHub error redaction', {
    gh: 'gh-token-leak',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: { terminal: 'cancelled', persistedDataExcludes: [rawToken] },
  });
});

test('D35: merge conflict reaches recovery with DIRTY merge-state evidence', { skip: e2eSkip }, async () => {
  await runCase('D35', 'D35: merge conflict recovery', {
    gh: 'merge-conflict',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel' },
    ],
    expect: {
      terminal: 'cancelled',
      events: ['integrate_succeeded', 'pipeline_blocked'],
      blockedDecision: {
        reason: 'poll-pr',
        lessonIncludes: ['mergeStateStatus=DIRTY'],
      },
    },
  });
});

test('D30: CI failure rework converges to green and merges', { skip: e2eSkip }, async () => {
  await runCase('D30', 'D30: CI rework', {
    gh: 'ci-red-then-green',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['integrate_succeeded', 'pr_polled', 'merge_confirmed', 'run_completed'],
    },
  });
});

for (const [caseId, decision] of [
  ['D31', 'fix'],
  ['D32', 'wontfix'],
] as const) {
  test(`${caseId}: review feedback is triaged, answered, and merged`, { skip: e2eSkip }, async () => {
    await runCase(caseId, `${caseId}: review feedback ${decision}`, {
      gh: 'review-comment',
      agent: { byRole: { triager: { kind: 'triage', decisions: [decision] } } },
      gates: [
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
      ],
      expect: {
        terminal: 'completed',
        events: ['pr_polled', 'threads_responded', 'merge_confirmed', 'run_completed'],
      },
    });
  });
}

test('D33: a human question decision resolves review feedback before merge', { skip: e2eSkip }, async () => {
  await runCase('D33', 'D33: review feedback question', {
    gh: 'review-comment',
    agent: { byRole: { triager: { kind: 'triage', decisions: ['question'] } } },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'question',
        options: QUESTION_OPTIONS,
        outcome: 'wontfix',
        note: 'the requested rewrite is out of scope for this run',
      },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['pr_polled', 'threads_responded', 'merge_confirmed', 'run_completed'],
    },
  });
});
