import { after, before, test } from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
} from '../support/pipeline-context.js';

const PIPELINE = 'feature-pr-watch';
const PIPELINE_POLL = 'feature-pr-poll';

let pipeline: PipelineContext;
let target: PipelineTarget;
const PLAN_OPTIONS = ['approved'] as const;
const MERGE_OPTIONS = ['approved'] as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
  target = pipeline.target();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('K1: a playbook-declared post-integrator role runs and completes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'K1: embedded post-integrator role',
    coverage: nonDslPipelineCaseAttachment('K1'),
    repo: target,
    pipelineId: PIPELINE,
    profile: 'fixture-integrator',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['integrate_succeeded', 'run_completed'],
      agentCalled: ['pr-watcher'],
      agentAfterEvent: [{ role: 'pr-watcher', event: 'integrate_succeeded' }],
    },
  });
});

test('K2: the embedded role blocker verdict drives bounded rework to blocked', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'K2: embedded role blocks',
    coverage: nonDslPipelineCaseAttachment('K2'),
    repo: target,
    pipelineId: PIPELINE,
    profile: 'fixture-integrator',
    agent: { byRole: { 'pr-watcher': { kind: 'verdict', verdict: 'blocker' } } },
    gates: [{ topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' }],
    expect: {
      terminal: 'blocked',
      events: ['pipeline_blocked'],
      agentCalled: ['pr-watcher'],
      agentCallMinimum: { developer: 2 },
    },
  });
});

test('K4: an unknown-id post-integrator role runs and completes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'K4: unknown-id post-integrator role',
    coverage: nonDslPipelineCaseAttachment('K4'),
    repo: target,
    pipelineId: PIPELINE_POLL,
    profile: 'fixture-integrator',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved' },
    ],
    expect: {
      terminal: 'completed',
      events: ['integrate_succeeded', 'run_completed'],
      agentCalled: ['pr-poller'],
      agentAfterEvent: [{ role: 'pr-poller', event: 'integrate_succeeded' }],
    },
  });
});
