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

function recoveryScenario(title: string, scenario: Omit<PipelineScenario, 'title' | 'playbook' | 'repo'>): void {
  test(title, { skip: e2eSkip }, async () => {
    await pipelineScenario(h, runCases, { title, playbook: 'default', repo: target, ...scenario });
  });
}

recoveryScenario('RG-A: mergeGate approve -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', {
  executionProfile: STUB_FULL,
  gates: [['plan', 'approved'], ['merge', 'approved']],
  expect: { terminal: 'completed' },
});

recoveryScenario('RG-B: mergeGate cancel -> cancelledEnd -> cancelled', {
  executionProfile: STUB_FULL,
  gates: [['plan', 'approved'], ['merge', 'cancel']],
  expect: { terminal: 'cancelled' },
});

recoveryScenario('RG-C: mergeGate override_merge -> mergeApproveReverify(stub:clean) -> confirmMerge -> completed', {
  executionProfile: STUB_FULL,
  gates: [
    ['plan', 'approved'],
    {
      topic: 'merge',
      outcome: 'override_merge',
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
  expect: { terminal: 'completed' },
});

test('RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)', {
  skip: e2eSkip,
}, async () => {
  await pipelineScenario(h, runCases, {
    title: 'RG-D: mergeGate recheck -> mergeRecheck(stub:clean) -> mergeGate cancel -> cancelled (#276)',
    playbook: 'default',
    repo: target,
    executionProfile: STUB_FULL,
    gates: [['plan', 'approved'], ['merge', 'recheck'], ['merge', 'cancel']],
    expect: { terminal: 'cancelled' },
  });
});

test('RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled', { skip: e2eSkip }, async () => {
  const targetE = createTargetRepo();
  try {
    await pipelineScenario(h, runCases, {
      title: 'RG-E: always-ci-red -> ciLoop exhaustion -> recoveryGate(merge-recovery) -> cancel -> cancelled',
      playbook: 'default',
      repo: targetE,
      executionProfile: STUB_AGENT,
      gh: 'always-ci-red',
      gates: [['plan', 'approved'], ['merge', 'cancel']],
      expect: { terminal: 'cancelled' },
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
      executionProfile: STUB_AGENT,
      gh: 'merge-unknown-then-clean',
      gates: [['plan', 'approved'], ['merge', 'approved']],
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
      executionProfile: STUB_AGENT,
      gh: 'merge-stale-at-reverify',
      gates: [['plan', 'approved'], ['merge', 'approved'], ['merge', 'cancel']],
      expect: {
        terminal: 'cancelled',
        noEvents: ['merge_confirmed'],
        ghNotCalled: [['pr', 'merge']],
      },
    });
  } finally {
    targetG.cleanup();
  }
});
