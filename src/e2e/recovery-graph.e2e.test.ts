import { before, after, test } from 'node:test';
import {
  RUN_REAL_E2E,
  e2eSkip,
  createRunHarness,
  type RunHarness,
  givenSeededDefaultPlaybook,
  createTargetRepo,
  type TargetRepo,
  routedGhEmulator,
  pipelineScenario,
  type PipelineScenario,
  type RunCase,
} from './kit/index.js';
import { coverageForScenario, type PipelineScenarioCoverage } from '../control-plane/pipeline-coverage-registry.js';

const STUB_AGENT = { runnerOverrides: { 'claude-code': 'stub-agent' } };
const STUB_FULL = { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } };

let h: RunHarness;
let target: TargetRepo;
const runCases = new Map<string, RunCase>();

before(async () => {
  if (!RUN_REAL_E2E) return;
  target = createTargetRepo();
  h = await createRunHarness({ gh: (calls) => routedGhEmulator(runCases, calls) });
  await givenSeededDefaultPlaybook(h);
});

after(async () => {
  if (h) await h.close();
  if (target) target.cleanup();
});

function recoveryScenario(
  title: string,
  coverage: PipelineScenarioCoverage,
  scenario: Omit<PipelineScenario, 'title' | 'playbook' | 'repo' | 'coverage'>,
): void {
  test(title, { skip: e2eSkip }, async () => {
    await pipelineScenario(h, runCases, { title, playbook: 'default', repo: target, coverage, ...scenario });
  });
}

recoveryScenario('RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', coverageForScenario('RG-A-merge-approved'), {
  executionProfile: STUB_FULL,
  gates: [['plan', 'approved'], { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' }],
  expect: { terminal: 'completed', path: ['merge_confirmed'] },
});

recoveryScenario('RG-B: mergeGate cancel -> cancelledEnd -> cancelled', coverageForScenario('RG-B-merge-cancel'), {
  executionProfile: STUB_FULL,
  gates: [['plan', 'approved'], { topic: 'merge', outcome: 'cancel', nodeId: 'mergeGate' }],
  expect: { terminal: 'cancelled' },
});

recoveryScenario('RG-C: mergeGate override_merge -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', coverageForScenario('RG-C-merge-override'), {
  executionProfile: STUB_FULL,
  gates: [
    ['plan', 'approved'],
    {
      topic: 'merge',
      outcome: 'override_merge',
      nodeId: 'mergeGate',
      note: 'e2e override: reviewed and accepting the open thread',
      mergeOverrideAudit: {
        threadIds: ['PRRT_OVERRIDE'],
        actor: 'e2e',
        reason: 'e2e override: reviewed and accepting the open thread',
        risk: 'low: synthetic stub run, no real merge side effects',
        verificationResponsibility: 'e2e harness',
        headSha: 'e2e-stub-head',
      },
    },
  ],
  expect: { terminal: 'completed', path: ['merge_confirmed'] },
});

test('RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)', {
  skip: e2eSkip,
}, async () => {
  await pipelineScenario(h, runCases, {
    title: 'RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)',
    playbook: 'default',
    repo: target,
    coverage: coverageForScenario('RG-D-merge-recheck-clean'),
    executionProfile: STUB_FULL,
    gates: [
      ['plan', 'approved'],
      { topic: 'merge', outcome: 'recheck', nodeId: 'mergeGate' },
      { topic: 'merge', outcome: 'cancel', nodeId: 'mergeGate' },
    ],
    expect: {
      terminal: 'cancelled',
      path: [{ type: 'pr_polled', payload: { verdict: 'clean' } }],
    },
  });
});

test('RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled', { skip: e2eSkip }, async () => {
  const targetE = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled',
      playbook: 'default',
      repo: targetE,
      coverage: coverageForScenario('RG-E-ci-loop-recovery'),
      executionProfile: STUB_AGENT,
      gh: 'always-ci-red',
      gates: [['plan', 'approved'], { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate' }],
      expect: {
        terminal: 'cancelled',
        path: [{ type: 'pr_polled', payload: { verdict: 'ci_changes' } }],
        noEvents: ['merge_confirmed'],
      },
    });
  } finally {
    targetE.cleanup();
  }
});

test('RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)', { skip: e2eSkip }, async () => {
  const targetF = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG-F: merge-unknown-then-clean -> bounded UNKNOWN recheck -> merge gate -> completed (AC#3)',
      playbook: 'default',
      repo: targetF,
      coverage: coverageForScenario('RG-F-unknown-then-clean'),
      executionProfile: STUB_AGENT,
      gh: 'merge-unknown-then-clean',
      gates: [['plan', 'approved'], { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' }],
      expect: {
        terminal: 'completed',
        path: [{ type: 'pr_polled', payload: { verdict: 'recheck' } }, 'merge_confirmed'],
      },
    });
  } finally {
    targetF.cleanup();
  }
});

test('RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)', { skip: e2eSkip }, async () => {
  const targetG = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG-G: merge-stale-at-reverify -> mergeGate approved -> recoveryGate -> cancel (AC#2)',
      playbook: 'default',
      repo: targetG,
      coverage: coverageForScenario('RG-G-stale-reverify-recovery'),
      executionProfile: STUB_AGENT,
      gh: 'merge-stale-at-reverify',
      gates: [
        ['plan', 'approved'],
        { topic: 'merge', outcome: 'approved', nodeId: 'mergeGate' },
        { topic: 'merge', outcome: 'cancel', nodeId: 'recoveryGate' },
      ],
      expect: {
        terminal: 'cancelled',
        path: [{
          type: 'pipeline_blocked',
          payload: { reason: 'poll-pr', nodeId: 'mergeApproveReverify' },
        }],
        agentNodeCalled: ['classifyRecovery'],
        noEvents: ['merge_confirmed'],
        ghNotCalled: [['pr', 'merge']],
      },
    });
  } finally {
    targetG.cleanup();
  }
});
