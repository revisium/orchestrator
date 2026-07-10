import { after, before, test } from 'node:test';
import { nonDslPipelineCaseAttachment } from '../../testing/policy/non-dsl-ownership.js';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
} from '../support/pipeline-context.js';

const PLAYBOOK_ID = 'revisium-agent-playbook-parallel-e2e';
const PIPELINE_ID = 'parallel-review-consensus-e2e';

let pipeline: PipelineContext;
let target: PipelineTarget;

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
  target = pipeline.target();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

test('N1: both approved reviewer branches arrive before the all-join completes', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'N1: approved parallel consensus',
    coverage: nonDslPipelineCaseAttachment('N1'),
    repo: target,
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    profile: 'fixture-agent',
    agent: {
      byRole: {
        reviewer: [
          { kind: 'domainVerdict', verdict: 'approved' },
          { kind: 'domainVerdict', verdict: 'approved' },
        ],
      },
    },
    expect: {
      terminal: 'completed',
      engine: 'data-driven',
      events: ['pipeline_fork', 'run_completed'],
      agentCallCount: { reviewer: 2 },
      reviewerConsensus: {
        nodeIds: ['primaryReview', 'secondaryReview'],
        verdicts: ['approved', 'approved'],
        attemptVerdicts: ['approved', 'approved'],
        requireProcessArtifacts: true,
      },
    },
  });
});

test('N2: exactly one non-approved reviewer blocks consensus', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'N2: mixed parallel consensus',
    coverage: nonDslPipelineCaseAttachment('N2'),
    repo: target,
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    profile: 'fixture-agent',
    agent: {
      byRole: {
        reviewer: [
          { kind: 'domainVerdict', verdict: 'changes_requested' },
          { kind: 'domainVerdict', verdict: 'approved' },
        ],
      },
    },
    expect: {
      terminal: 'blocked',
      agentCallCount: { reviewer: 2 },
      reviewerConsensus: {
        nodeIds: ['primaryReview', 'secondaryReview'],
        verdicts: ['changes_requested', 'approved'],
      },
    },
  });
});

test('N3: two non-approved reviewers both arrive before consensus blocks', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'N3: rejected parallel consensus',
    coverage: nonDslPipelineCaseAttachment('N3'),
    repo: target,
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    profile: 'fixture-agent',
    agent: {
      byRole: {
        reviewer: [
          { kind: 'domainVerdict', verdict: 'changes_requested' },
          { kind: 'domainVerdict', verdict: 'blocker' },
        ],
      },
    },
    expect: {
      terminal: 'blocked',
      agentCallCount: { reviewer: 2 },
      reviewerConsensus: {
        nodeIds: ['primaryReview', 'secondaryReview'],
        verdicts: ['changes_requested', 'blocker'],
      },
    },
  });
});

test('N4: approved plus clean satisfies the consensus pass set', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'N4: approved and clean parallel consensus',
    coverage: nonDslPipelineCaseAttachment('N4'),
    repo: target,
    playbookId: PLAYBOOK_ID,
    pipelineId: PIPELINE_ID,
    profile: 'fixture-agent',
    agent: {
      byRole: {
        reviewer: [
          { kind: 'domainVerdict', verdict: 'approved' },
          { kind: 'domainVerdict', verdict: 'clean' },
        ],
      },
    },
    expect: {
      terminal: 'completed',
      agentCallCount: { reviewer: 2 },
      reviewerConsensus: {
        nodeIds: ['primaryReview', 'secondaryReview'],
        verdicts: ['approved', 'clean'],
      },
    },
  });
});
