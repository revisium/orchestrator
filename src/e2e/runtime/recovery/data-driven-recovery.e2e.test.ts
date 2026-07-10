import { after, before, test } from 'node:test';
import { e2eSkip, RUN_REAL_E2E } from '../../support/env.js';
import {
  prepareDataDrivenRecovery,
  type RecoveredRun,
  type RecoveryContext,
} from '../../support/recovery-context.js';

let context: RecoveryContext;
let mergeResume: RecoveredRun;

const mergeApproval = {
  topic: 'merge',
  options: ['approved', 'changes_requested'],
  outcome: 'approved',
} as const;

before(async () => {
  if (!RUN_REAL_E2E) return;
  const prepared = await prepareDataDrivenRecovery();
  context = prepared.context;
  mergeResume = prepared.mergeResume;
});

after(async () => {
  if (context) await context.close();
});

test('L2: data-driven merge-gate recovery completes with exactly-once effects', { skip: e2eSkip }, async () => {
  await mergeResume.waitAtGate('merge');
  await mergeResume.resolveToCompletion([mergeApproval]);
  await mergeResume.expectEvents(['run_completed']);
  await mergeResume.expectReplayExactlyOnce();
});
