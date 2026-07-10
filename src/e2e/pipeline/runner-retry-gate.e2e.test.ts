import { before, after, test } from 'node:test';
import {
  coverageForScenario,
} from '../../testing/policy/pipeline-coverage.js';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineAgentPlan,
  type PipelineContext,
} from '../support/pipeline-context.js';

let pipeline: PipelineContext;
const PLAN_OPTIONS = ['approved', 'rework', 'cancel'] as const;
const MERGE_OPTIONS = [
  'approved',
  'recheck',
  'address_review_threads',
  'return_to_development',
  'override_merge',
  'cancel',
] as const;
const RETRY_OPTIONS = ['retry', 'give_up'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

function developerFailsThenPasses(reason: string): PipelineAgentPlan {
  return {
    byRole: {
      developer: [
        { kind: 'throw', message: reason },
        { kind: 'throw', message: reason },
        { kind: 'pass' },
      ],
    },
  };
}

function developerFails(reason: string): PipelineAgentPlan {
  return {
    byRole: {
      developer: [
        { kind: 'throw', message: reason },
        { kind: 'throw', message: reason },
      ],
    },
  };
}

function analystAsksTwiceThenPasses(firstLesson: string, secondLesson: string): PipelineAgentPlan {
  return {
    byRole: {
      analyst: [
        { kind: 'needsHuman', lesson: firstLesson },
        { kind: 'needsHuman', lesson: secondLesson },
        { kind: 'pass' },
      ],
    },
  };
}

test('RG234-A: exhausted transient developer failure -> retry gate -> retry completes in the same run/worktree', {
  skip: e2eSkip,
}, async () => {
  await pipeline.run({
      title: 'RG234-A: retry transient developer failure',
      coverage: nonDslPipelineCaseAttachment('RG234-A'),
      playbook: 'default',
      repo: pipeline.target(),
      agent: developerFailsThenPasses('scripted developer crash: transport disconnected'),
      gates: [
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        {
          topic: 'retry',
          options: RETRY_OPTIONS,
          outcome: 'retry',
          reconcile: 'keep',
          summaryIncludes: ['transient_retry', 'developer', 'attemptsExhausted'],
        },
        { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
      ],
      expect: {
        terminal: 'completed',
        events: ['runner_retry_exhausted', 'run_completed'],
        noEvents: ['run_recovery_created'],
        path: [{ type: 'step_succeeded', payload: { stepKey: 'developer#2', attemptNo: 1 } }],
        agentCallCount: { developer: 3, analyst: 1 },
        sameWorktreeForAgent: ['developer'],
      },
  });
});

test('RG234-B: exhausted transient developer failure -> retry gate -> give_up preserves blocked behavior', {
  skip: e2eSkip,
}, async () => {
  await pipeline.run({
      title: 'RG234-B: give up transient developer failure',
      coverage: nonDslPipelineCaseAttachment('RG234-B'),
      playbook: 'default',
      repo: pipeline.target(),
      agent: developerFails('scripted developer crash: transport disconnected'),
      gates: [
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        {
          topic: 'retry',
          options: RETRY_OPTIONS,
          outcome: 'give_up',
          summaryIncludes: ['transient_retry', 'developer', 'attemptsExhausted'],
        },
      ],
      expect: {
        terminal: 'blocked',
        events: ['runner_retry_exhausted', 'pipeline_blocked'],
        noEvents: ['run_completed', 'run_recovery_created'],
      },
  });
});

test('RG234-C: 529 Overloaded is transient enough to reach the manual retry gate', {
  skip: e2eSkip,
}, async () => {
  await pipeline.run({
      title: 'RG234-C: 529 overloaded reaches retry gate',
      coverage: nonDslPipelineCaseAttachment('RG234-C'),
      playbook: 'default',
      repo: pipeline.target(),
      agent: developerFails('provider 529 Overloaded; please retry later'),
      gates: [
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        {
          topic: 'retry',
          options: RETRY_OPTIONS,
          outcome: 'give_up',
          summaryIncludes: ['transient_retry', 'overloaded', '529'],
        },
      ],
      expect: {
        terminal: 'blocked',
        events: ['runner_retry_exhausted', 'pipeline_blocked'],
      },
  });
});

test('RG234-D: agent needsHuman question -> answer resumes the same run and reaches the retrying agent', {
  skip: e2eSkip,
}, async () => {
  const providerAnswer = { provider: 'oauth', reason: 'use existing OAuth tenant' };
  const regionAnswer = { region: 'eu', reason: 'match customer data residency' };
  await pipeline.run({
      title: 'RG234-D: analyst question resumes with answer',
      playbook: 'default',
      repo: pipeline.target(),
      coverage: coverageForScenario('RG234-D-agent-question-resume'),
      agent: analystAsksTwiceThenPasses(
        'which auth provider should the feature use?',
        'which region should the feature use?',
      ),
      gates: [
        {
          topic: 'question',
          answer: providerAnswer,
          summaryIncludes: ['analyst', 'which auth provider should the feature use?'],
        },
        {
          topic: 'question',
          answer: regionAnswer,
          summaryIncludes: ['analyst', 'which region should the feature use?'],
        },
        { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
        { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
      ],
      expect: {
        terminal: 'completed',
        events: ['agent_question_opened', 'agent_question_resolved', 'run_completed'],
        noEvents: ['pipeline_blocked', 'run_recovery_created'],
        agentCallCount: { analyst: 3 },
        agentRetryContexts: [
          {
            role: 'analyst',
            callIndex: 1,
            kind: 'agent_question',
            nodeId: 'analyst',
            answer: providerAnswer,
            lesson: 'which auth provider should the feature use?',
            resolvedBy: 'e2e',
          },
          {
            role: 'analyst',
            callIndex: 2,
            kind: 'agent_question',
            nodeId: 'analyst',
            answer: regionAnswer,
            lesson: 'which region should the feature use?',
            resolvedBy: 'e2e',
            distinctInboxFromCallIndex: 1,
          },
        ],
      },
  });
});
