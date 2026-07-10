import { before, after, test } from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import { createPipelineContext, type PipelineContext } from '../support/pipeline-context.js';

let pipeline: PipelineContext;
const PLAN_OPTIONS = ['approved'] as const;
const MERGE_OPTIONS = ['approved', 'recheck', 'override_merge', 'cancel'] as const;
const RETRY_OPTIONS = ['retry', 'give_up'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('C1: a blocking review triggers rework, then the run completes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'C1: blocking review reworks once',
    coverage: nonDslPipelineCaseAttachment('C1'),
    repo: pipeline.target(),
    profile: 'fixture-agent',
    agent: {
      byRole: { reviewer: [{ kind: 'pass' }, { kind: 'verdict', verdict: 'blocker' }, { kind: 'pass' }] },
    },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: { terminal: 'completed', agentCallMinimum: { developer: 2 } },
  });
});

test('C2: a review that never passes blocks the pipeline at the iteration cap', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'C2: review cap blocks',
    coverage: nonDslPipelineCaseAttachment('C2'),
    repo: pipeline.target(),
    profile: 'fixture-agent',
    agent: { byRole: { reviewer: { kind: 'verdict', verdict: 'blocker' } } },
    gates: [{ topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' }],
    expect: { terminal: 'blocked', events: ['pipeline_blocked'] },
  });
});

test('C3: a developer that throws reaches the retry gate and does not complete after give_up', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'C3: developer failure reaches retry gate',
    coverage: nonDslPipelineCaseAttachment('C3'),
    repo: pipeline.target(),
    profile: 'fixture-agent',
    agent: { byRole: { developer: { kind: 'throw', message: 'scripted developer crash' } } },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'retry', options: RETRY_OPTIONS, outcome: 'give_up' },
    ],
    expect: {
      terminal: 'blocked',
      events: ['runner_retry_exhausted', 'pipeline_blocked'],
      noEvents: ['run_completed'],
    },
  });
});

test('C4: markdown output without top-level verdict terminal-fails as invalid result', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'C4: invalid agent result fails',
    coverage: nonDslPipelineCaseAttachment('C4'),
    repo: pipeline.target(),
    profile: 'fixture-agent',
    agent: { byRole: { reviewer: { kind: 'invalidNoVerdict', output: '# Review\napproved' } } },
    expect: {
      terminal: 'failed',
      events: ['step_failed', 'run_failed'],
      failureReasonIncludes: ['revo.ResultInvalid'],
    },
  });
});
