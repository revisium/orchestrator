import { before, after, test } from 'node:test';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineCasePlan,
  type PipelineContext,
  type PipelineTarget,
} from '../support/pipeline-context.js';
import {
  coverageForScenario,
  type PipelineScenarioCoverage,
} from '../../testing/policy/pipeline-coverage.js';

let pipeline: PipelineContext;
let target: PipelineTarget;
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

before(async () => {
  if (!RUN_REAL_E2E) return;
  pipeline = await createPipelineContext();
  target = pipeline.target();
});

after(async () => {
  if (pipeline) await pipeline.close();
});

function recoveryScenario(
  title: string,
  coverage: PipelineScenarioCoverage,
  scenario: Omit<PipelineCasePlan, 'title' | 'playbook' | 'repo' | 'coverage'>,
): void {
  test(title, { skip: e2eSkip }, async () => {
    await pipeline.run({ title, playbook: 'default', repo: target, coverage, ...scenario });
  });
}

recoveryScenario('RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', coverageForScenario('RG-A-merge-approved'), {
  profile: 'default-full',
  gates: [
    { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
    { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
  ],
  expect: { terminal: 'completed', path: ['merge_confirmed'] },
});

recoveryScenario('RG-B: mergeGate cancel -> cancelledEnd -> cancelled', coverageForScenario('RG-B-merge-cancel'), {
  profile: 'default-full',
  gates: [
    { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
    { topic: 'merge', options: MERGE_OPTIONS, outcome: 'cancel', nodeId: 'mergeGate' },
  ],
  expect: { terminal: 'cancelled' },
});

recoveryScenario('RG-C: mergeGate override_merge over advisory thread -> confirmMerge -> completed', coverageForScenario('RG-C-merge-override'), {
  profile: 'default-full',
  gh: 'force-advisory-thread',
  gates: [
    { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
    {
      topic: 'merge',
      options: MERGE_OPTIONS,
      outcome: 'override_merge',
      nodeId: 'mergeGate',
      note: 'e2e override: reviewed and accepting the open thread',
      mergeOverrideAudit: {
        threadIds: ['PRRT_T1'],
        actor: 'e2e',
        reason: 'e2e override: reviewed and accepting the open thread',
        risk: 'low: synthetic stub run, no real merge side effects',
        verificationResponsibility: 'e2e harness',
        headSha: 'deadbeefcafe',
      },
    },
  ],
  expect: { terminal: 'completed', path: ['merge_overridden', 'merge_confirmed'] },
});

test('RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)', {
  skip: e2eSkip,
}, async () => {
  await pipeline.run({
    title: 'RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)',
    playbook: 'default',
    repo: target,
    coverage: coverageForScenario('RG-D-merge-recheck-clean'),
    profile: 'default-full',
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

test('RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled',
    playbook: 'default',
    repo: pipeline.target(),
    coverage: coverageForScenario('RG-E-ci-loop-recovery'),
    gh: 'always-ci-red',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'ci_changes' } }],
      noEvents: ['merge_confirmed'],
    },
  });
});

test('RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)',
    playbook: 'default',
    repo: pipeline.target(),
    coverage: coverageForScenario('RG-F-unknown-then-clean'),
    gh: 'merge-unknown-then-clean',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
    ],
    expect: {
      terminal: 'completed',
      path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }, 'merge_confirmed'],
    },
  });
});

test('RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)', { skip: e2eSkip }, async () => {
  await pipeline.run({
    title: 'RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)',
    playbook: 'default',
    repo: pipeline.target(),
    coverage: coverageForScenario('RG-G-stale-reverify-recovery'),
    gh: 'merge-stale-at-reverify',
    gates: [
      { topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
      { topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{
        type: 'pipeline_blocked',
        payload: { reason: 'poll-pr', nodeId: 'mergeApproveReverify' },
      }],
      agentNodeCalled: ['classifyRecovery'],
      noEvents: ['merge_confirmed'],
      forbiddenSideEffects: ['merge_pull_request'],
    },
  });
});
