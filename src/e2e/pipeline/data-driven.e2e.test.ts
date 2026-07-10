import { after, before, test } from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineAgentPlan,
  type PipelineContext,
  type PipelineTarget,
} from '../support/pipeline-context.js';

let pipeline: PipelineContext;
let target: PipelineTarget;
const PLAN_OPTIONS = ['approved', 'changes_requested'] as const;
const MERGE_OPTIONS = ['approved', 'changes_requested'] as const;
const CODE_STUCK_OPTIONS = ['approve_anyway', 'rework', 'abort'] as const;

const cleanWatcher: PipelineAgentPlan = {
  byRole: { watcher: { kind: 'domainVerdict', verdict: 'clean' } },
};

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
  target = pipeline.target();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('L1: a data-driven run drives plan and merge gates to completion', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'L1: data-driven feature run',
    coverage: nonDslPipelineCaseAttachment('L1'),
    repo: target,
    pipelineId: 'feature-development-dd',
    profile: 'fixture-full',
    agent: cleanWatcher,
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      events: ['integrate_succeeded', 'run_completed'],
      agentCalled: ['analyst', 'developer', 'reviewer', 'watcher'],
    },
  });
});

test('L4: a produced plan is hydrated into the consuming developer context', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'L4: data-driven produced plan',
    coverage: nonDslPipelineCaseAttachment('L4'),
    repo: target,
    pipelineId: 'feature-development-dd',
    profile: 'fixture-full',
    agent: cleanWatcher,
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      agentContextIncludes: {
        developer: ['## Inputs (from previous steps)', '"role": "analyst"'],
      },
    },
  });
});

test('L3: reviewer blockers exhaust the data-declared cap and abort at the stuck gate', { skip: e2eSkip }, async () => {
  const blockerReviewer: PipelineAgentPlan = {
    byRole: {
      reviewer: { kind: 'verdict', verdict: 'blocker' },
      watcher: { kind: 'domainVerdict', verdict: 'clean' },
    },
  };

  await pipeline.run({
    title: 'L3: data-driven review cap',
    coverage: nonDslPipelineCaseAttachment('L3'),
    repo: target,
    pipelineId: 'feature-development-dd',
    profile: 'fixture-full',
    agent: blockerReviewer,
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        topic: 'plan',
        options: CODE_STUCK_OPTIONS,
        outcome: 'abort',
        nodeId: 'codeStuckGate',
      },
    ],
    expect: {
      terminal: 'blocked',
      events: ['pipeline_blocked'],
      agentCallMinimum: { developer: 2 },
    },
  });
});
