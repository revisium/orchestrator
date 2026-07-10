import { after, before, test } from 'node:test';
import { coverageForScenario } from '../../testing/policy/pipeline-coverage.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
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

function target(): PipelineTarget {
  return pipeline.target();
}

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('M1b: shipped consensus disagreement reworks and then completes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'M1b: shipped consensus disagreement',
    repo: target(),
    playbook: 'default',
    profileId: 'codex-primary-claude-review-consensus',
    coverage: coverageForScenario('M1b-profile-consensus-rework'),
    agent: {
      byRole: {
        reviewer: [
          { kind: 'verdict', verdict: 'changes_requested' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
          { kind: 'pass' },
        ],
      },
    },
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      events: ['pipeline_fork', 'run_completed'],
      agentCallCount: { analyst: 2, reviewer: 6 },
      agentCalled: ['developer'],
    },
  });
});

test('M1c: shipped standard profile completes the single-review signature', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'M1c: shipped single-review profile',
    repo: target(),
    playbook: 'default',
    profileId: 'codex-standard',
    coverage: coverageForScenario('M1-profile-single'),
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      agentCallCount: { reviewer: 2 },
    },
  });
});

test('M2: shipped local-change profile completes without a gate', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'M2: shipped local-change profile',
    repo: target(),
    playbook: 'default',
    pipelineId: 'local-change',
    profileId: 'local-change-codex-standard',
    coverage: coverageForScenario('M2-profile-local-change'),
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      agentCalled: ['developer'],
      agentCallCount: { reviewer: 0 },
    },
  });
});

test('M3: shipped analysis-only profile completes without a gate', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'M3: shipped analysis-only profile',
    repo: target(),
    playbook: 'default',
    pipelineId: 'analysis-only',
    profileId: 'analysis-only-codex-standard',
    developerWrite: false,
    coverage: coverageForScenario('M3-profile-analysis-only'),
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      agentCalled: ['analyst'],
      agentCallCount: { developer: 0, reviewer: 0 },
    },
  });
});
