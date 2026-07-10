import { after, before, test } from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import { createPipelineContext, type PipelineContext } from '../support/pipeline-context.js';

let pipeline: PipelineContext;
const PLAN_OPTIONS = ['approved'] as const;
const MERGE_OPTIONS = ['approved', 'recheck', 'override_merge', 'cancel'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('B3: plan-gate reject blocks the run and developer never executes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'B3: rejected plan blocks before development',
    coverage: nonDslPipelineCaseAttachment('B3'),
    repo: pipeline.target(),
    gates: [{ topic: 'plan', options: PLAN_OPTIONS, action: 'reject' }],
    expect: {
      terminal: 'blocked',
      noEvents: ['run_completed'],
      agentCallCount: { developer: 0 },
    },
  });
});

test('B4: merge-gate recheck re-polls readiness and re-presents the merge gate', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'B4: merge recheck returns to merge gate',
    coverage: nonDslPipelineCaseAttachment('B4'),
    repo: pipeline.target(),
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'recheck', nodeId: 'mergeGate' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'cancel', nodeId: 'mergeGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
    },
  });
});

test('B10: a parked gate exposes its pending decision and risk summary', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'B10: plan gate visibility',
    coverage: nonDslPipelineCaseAttachment('B10'),
    repo: pipeline.target(),
    gates: [
      {
        topic: 'plan',
        options: PLAN_OPTIONS,
        outcome: 'approved',
        pendingRisk: { topic: 'plan', kind: 'approval' },
      },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: { terminal: 'completed' },
  });
});

test('B13: a parked plan gate carries the plan artifact and reviewer verdict', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'B13: plan gate decision context',
    coverage: nonDslPipelineCaseAttachment('B13'),
    repo: pipeline.target(),
    gates: [
      {
        topic: 'plan',
        options: PLAN_OPTIONS,
        outcome: 'approved',
        nodeId: 'planGate',
        requirePlanArtifact: true,
      },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: { terminal: 'completed' },
  });
});

test('B12: cancelling a run parked at a gate marks it cancelled', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'B12: cancel parked run',
    coverage: nonDslPipelineCaseAttachment('B12'),
    repo: pipeline.target(),
    gates: [{ topic: 'plan', options: PLAN_OPTIONS, action: 'cancel-run' }],
    expect: { terminal: 'cancelled', noEvents: ['run_completed'] },
  });
});
