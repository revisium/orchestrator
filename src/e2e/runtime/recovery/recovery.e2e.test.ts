import { after, before, test } from 'node:test';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';
import {
  prepareRecoveryCases,
  type RecoveredRun,
  type RecoveryContext,
} from '../../support/recovery-context.js';

let context: RecoveryContext;
let planResume: RecoveredRun;
let mergeResume: RecoveredRun;
let planReject: RecoveredRun;

const planApproval = { topic: 'plan', options: ['approved'], outcome: 'approved' } as const;
const mergeApproval = {
  topic: 'merge',
  options: ['approved', 'recheck', 'override_merge', 'cancel'],
  outcome: 'approved',
} as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  const cases = await prepareRecoveryCases();
  context = cases.context;
  planResume = cases.planResume;
  mergeResume = cases.mergeResume;
  planReject = cases.planReject;
});

after(async () => {
  if (context) await context.close();
});

test('F1: a plan-gate crash recovers and resumes to completion', { skip: e2eSkip }, async () => {
  await planResume.waitAtGate('plan');
  await planResume.resolveToCompletion([planApproval, mergeApproval]);
  await planResume.expectEvents(['run_completed']);
});

test('F2: a merge-gate crash recovers with exactly-once effects', { skip: e2eSkip }, async () => {
  await mergeResume.waitAtGate('merge');
  await mergeResume.resolveToCompletion([mergeApproval]);
  await mergeResume.expectReplayExactlyOnce();
});

test('F3: a recovered plan gate can still route to blocked', { skip: e2eSkip }, async () => {
  await planReject.rejectAtPlan();
});
