import { before, after, test } from 'node:test';
import { RUN_REAL_E2E, e2eSkip } from '../support/env.js';
import {
  createPipelineContext,
  type PipelineContext,
  type PipelineTarget,
} from '../support/pipeline-context.js';
import {
  coverageForScenario,
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

test('RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-A-merge-approved'),
    given: {
      title: 'RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed',
      playbook: 'default',
      repo: target,
      profile: 'default-full',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
    ],
    then: { terminal: 'completed', path: ['merge_confirmed'] },
  });
});

test('RG-B: mergeGate cancel -> cancelledEnd -> cancelled', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-B-merge-cancel'),
    given: {
      title: 'RG-B: mergeGate cancel -> cancelledEnd -> cancelled',
      playbook: 'default',
      repo: target,
      profile: 'default-full',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'cancel', nodeId: 'mergeGate' },
    ],
    then: { terminal: 'cancelled' },
  });
});

test('RG-C: mergeGate override_merge over advisory thread -> confirmMerge -> completed', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-C-merge-override'),
    given: {
      title: 'RG-C: mergeGate override_merge over advisory thread -> confirmMerge -> completed',
      playbook: 'default',
      repo: target,
      profile: 'default-full',
      gh: 'force-advisory-thread',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      {
        do: 'resolveGate',
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
    then: { terminal: 'completed', path: ['merge_overridden', 'merge_confirmed'] },
  });
});

test('RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-D-merge-recheck-clean'),
    given: {
      title: 'RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)',
      playbook: 'default',
      repo: target,
      profile: 'default-full',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'recheck', nodeId: 'mergeGate' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'cancel', nodeId: 'mergeGate' },
    ],
    then: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
    },
  });
});

test('RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-E-ci-loop-recovery'),
    given: {
      title: 'RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled',
      playbook: 'default',
      repo: pipeline.target(),
      gh: 'always-ci-red',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    then: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'ci_changes' } }],
      noEvents: ['merge_confirmed'],
    },
  });
});

test('RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-F-unknown-then-clean'),
    given: {
      title: 'RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)',
      playbook: 'default',
      repo: pipeline.target(),
      gh: 'merge-unknown-then-clean',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
    ],
    then: {
      terminal: 'completed',
      path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }, 'merge_confirmed'],
    },
  });
});

test('RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)', { skip: e2eSkip }, async () => {
  await pipeline.execute({
    coverage: coverageForScenario('RG-G-stale-reverify-recovery'),
    given: {
      title: 'RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)',
      playbook: 'default',
      repo: pipeline.target(),
      gh: 'merge-stale-at-reverify',
    },
    when: [
      { do: 'resolveGate', topic: 'plan', options: PLAN_OPTIONS, outcome: 'approved' },
      { do: 'resolveGate', topic: 'merge', options: MERGE_OPTIONS, outcome: 'approved', nodeId: 'mergeGate' },
      { do: 'resolveGate', topic: 'merge', options: RECOVERY_OPTIONS, outcome: 'cancel', nodeId: 'recoveryGate' },
    ],
    then: {
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
