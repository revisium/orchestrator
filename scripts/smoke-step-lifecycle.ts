import { createControlPlaneDataAccess } from '../src/control-plane/index.js';
import { createRunWorkflow } from '../src/run/create-run.js';
import {
  claimNextStep,
  startAttempt,
  writeResult,
  createSteps,
  failStep,
  recoverInFlight,
} from '../src/control-plane/steps.js';

const da = createControlPlaneDataAccess();
await da.assertReady();

// ─── Smoke 1: claim → running → succeeded ─────────────────────────────────────

// Create a ready architect step (and any previously ready steps that may exist).
await createRunWorkflow(da, {
  title: `Smoke step lifecycle ${Date.now()}`,
  repo: '.',
  description: 'Plan 0006 smoke',
});

// claimNextStep picks the highest-priority ready step; may be this run's or an older one.
const step1 = await claimNextStep(da, 'smoke-worker', ['architect']);
if (!step1) throw new Error('Expected a claimable step but got null');
if (step1.status !== 'claimed') throw new Error(`Expected claimed, got ${step1.status}`);

const { attemptId: attemptId1 } = await startAttempt(da, step1, {
  workerId: 'smoke-worker',
  modelProfile: 'standard',
});

const attemptRow1 = await da.getRow('attempts', attemptId1);
if (!attemptRow1) throw new Error(`Missing attempt row ${attemptId1}`);
if (attemptRow1.data.status !== 'running') throw new Error(`Attempt not running: ${String(attemptRow1.data.status)}`);

const stepAfterStart = await da.getRow('steps', step1.id);
if (stepAfterStart?.data.status !== 'running') throw new Error('Step not running after startAttempt');

await writeResult(da, { ...step1, status: 'running', attemptCount: step1.attemptCount + 1 }, attemptId1, { done: true }, [
  { modelProfile: 'standard', inputTokens: 100, outputTokens: 50, costAmount: 0.001 },
]);

const stepAfterResult = await da.getRow('steps', step1.id);
if (stepAfterResult?.data.status !== 'succeeded') throw new Error(`Step not succeeded after writeResult: ${String(stepAfterResult?.data.status)}`);
if (typeof stepAfterResult.data.output !== 'object') throw new Error('Output is not an object');

const attemptAfterResult = await da.getRow('attempts', attemptId1);
if (attemptAfterResult?.data.status !== 'succeeded') throw new Error('Attempt not succeeded');

console.log(`smoke1: claim→running→succeeded OK (step=${step1.id} attempt=${attemptId1})`);

// ─── Smoke 2: createSteps ─────────────────────────────────────────────────────

await createSteps(da, [
  { taskId: step1.taskId, runId: step1.runId, role: 'developer', kind: 'implement', input: { source: 'smoke' }, modelProfile: 'cheap' },
  { taskId: step1.taskId, runId: step1.runId, role: 'tester', kind: 'test', input: null, modelProfile: 'cheap', dependsOn: ['something'] },
]);

const readyDev = await claimNextStep(da, 'smoke-worker', ['developer']);
if (!readyDev) throw new Error('Expected developer step after createSteps');
if (readyDev.status !== 'claimed') throw new Error(`Expected claimed, got ${readyDev.status}`);

console.log(`smoke2: createSteps+claim OK (role=${readyDev.role})`);

// ─── Smoke 3: failStep → ready (backoff) ──────────────────────────────────────

await createRunWorkflow(da, { title: `Smoke failStep ${Date.now()}`, repo: '.' });

// Claim some architect step and fail it.
const step2 = await claimNextStep(da, 'smoke-worker', ['architect']);
if (!step2) throw new Error('Expected step2 to claim');

const { attemptId: attemptId2 } = await startAttempt(da, step2, { workerId: 'smoke-worker' });

// Fail with attempts remaining (maxAttempts=3, attemptCount=0 → newCount=1 < 3 → ready)
const step2AttemptCount = step2.attemptCount;
const step2MaxAttempts = step2.maxAttempts;
await failStep(da, { ...step2, status: 'running', attemptCount: step2AttemptCount }, attemptId2, {
  lesson: 'smoke test failure',
  error: 'intentional',
});

const stepAfterFail = await da.getRow('steps', step2.id);
const expectedStatus = step2AttemptCount + 1 < step2MaxAttempts ? 'ready' : 'dead';
if (stepAfterFail?.data.status !== expectedStatus) {
  throw new Error(`Expected ${expectedStatus} after failStep, got ${String(stepAfterFail?.data.status)}`);
}

const attemptAfterFail = await da.getRow('attempts', attemptId2);
if (attemptAfterFail?.data.status !== 'failed') throw new Error('Attempt not failed');

console.log(`smoke3: failStep→${expectedStatus} OK (step=${step2.id} run_after=${String(stepAfterFail.data.run_after)})`);

// ─── Smoke 4: crash recovery ──────────────────────────────────────────────────

// Use a unique crash worker id for isolation.
const crashWorkerId = `smoke-worker-crash-${Date.now()}`;
await createRunWorkflow(da, { title: `Smoke recovery ${Date.now()}`, repo: '.' });

const step3 = await claimNextStep(da, crashWorkerId, ['architect']);
if (!step3) throw new Error('Expected step3 to claim');

const { attemptId: attemptId3 } = await startAttempt(da, step3, { workerId: crashWorkerId });

// Simulate crash: call recoverInFlight without writeResult/failStep.
const recovered = await recoverInFlight(da, crashWorkerId);

if (!recovered.some((s) => s.id === step3.id)) throw new Error(`step3 ${step3.id} not in recovered list`);

const stepAfterRecovery = await da.getRow('steps', step3.id);
if (stepAfterRecovery?.data.status !== 'ready') throw new Error(`Step not ready after recovery: ${String(stepAfterRecovery?.data.status)}`);
if (stepAfterRecovery.data.lease_owner !== '') throw new Error('lease_owner not cleared after recovery');

const attemptAfterRecovery = await da.getRow('attempts', attemptId3);
if (attemptAfterRecovery?.data.status !== 'failed') throw new Error('Orphan attempt not failed after recovery');
if (attemptAfterRecovery.data.lesson !== 'worker crashed mid-step') throw new Error('Orphan attempt lesson wrong');

console.log(`smoke4: crash→recovery OK (step=${step3.id} attempt=${attemptId3})`);

// ─── Verify: no runtime commit was created ─────────────────────────────────────

const headDa = createControlPlaneDataAccess({ revision: 'head' });
const headStep1 = await headDa.getRow('steps', step1.id);
if (headStep1 !== null) throw new Error(`smoke step ${step1.id} unexpectedly visible from head`);

console.log('smoke5: no runtime commit OK');

console.log(`
smoke:step-lifecycle PASSED
  step1=${step1.id} attempt1=${attemptId1}
  step2=${step2.id} attempt2=${attemptId2}
  step3=${step3.id} attempt3=${attemptId3}
`);
