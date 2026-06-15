// recovery-crash-child.ts — Group F crash simulator.
//
// Boots a host, starts a stubbed feature run, drives it to a durable stop point (plan or merge gate),
// prints `RUNID=<id>`, then exits ABRUPTLY without draining DBOS — exactly as if the host process
// were killed. The in-flight workflow is left PENDING in Postgres; the parent test then boots a fresh
// host whose DBOS.launch() recovers + replays it. A separate process is required: DBOS is a
// process-global singleton, so true crash-recovery cannot be simulated in-process.
//
// Spawned by `crashRunAt` (kit/crash.ts) via tsx, inheriting the REVO_DATA_DIR/REVO_PORT env so it
// targets the isolated test daemon. argv[2] = stop point: 'plan-gate' (default) | 'merge-gate'.
import 'reflect-metadata';
import {
  createRunHarness,
  givenInstalledPlaybook,
  createTargetRepo,
  startStubbedFeatureRun,
  waitForGate,
} from './kit/index.js';

const stopAt = process.argv[2] ?? 'plan-gate';

const h = await createRunHarness();
await givenInstalledPlaybook(h);
// A clean throwaway repo path; the stub integrator never touches it. Intentionally NOT cleaned up —
// the process is about to "crash", and the OS reaps the temp dir. Leaking one /tmp dir per crash is
// cheaper than wiring a teardown that a crash would skip anyway.
const target = createTargetRepo();
const run = await startStubbedFeatureRun(h, target);

const plan = await waitForGate(h.api, run.runId, 'plan');
if (stopAt === 'merge-gate') {
  await h.api.approveGate({ inboxId: plan.inboxId, resolvedBy: 'crash-child' });
  await waitForGate(h.api, run.runId, 'merge');
}

// Flush the run id, then exit WITHOUT h.close() — no DBOS drain → the workflow stays PENDING in
// Postgres (the crash). exit(0) inside the write callback guarantees the parent reads RUNID first.
process.stdout.write(`RUNID=${run.runId}\n`, () => process.exit(0));
