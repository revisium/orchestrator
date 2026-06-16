// recovery-dd-crash-child.ts — Group L crash simulator for the DATA-DRIVEN pipeline (0015 slice 2).
//
// Mirrors recovery-crash-child.ts but starts a run on the data-driven `feature-development-dd` pipeline
// (the pipeline-core graph executed by the DBOS effect-adapter). Boots a host, drives the run to a
// durable stop point (plan or merge gate), prints `RUNID=<id>`, then exits ABRUPTLY without draining
// DBOS — exactly as if the host were killed. The in-flight DATA-DRIVEN workflow is left PENDING in
// Postgres; the parent test boots a fresh host whose DBOS.launch() recovers + replays it. A separate
// process is mandatory: DBOS is a process-global singleton, so a true crash cannot be faked in-process.
//
// Spawned by `crashDataDrivenRunAt` (kit/crash.ts) via tsx, inheriting REVO_DATA_DIR/REVO_PORT.
// argv[2] = stop point: 'plan-gate' (default) | 'merge-gate'.
//
// Uses a SINGLE scriptedAgent (not per-run routed) so the data-driven watcher node always emits the
// `clean` DOMAIN verdict it needs to reach the merge gate — independent of runId and process. The
// default all-PASS agent would route the watcher to `failedEnd`; a per-run spec map cannot cross the
// crash→recovery process boundary, so a constant spec is the deterministic choice here.
import 'reflect-metadata';
import {
  createRunHarness,
  givenInstalledPlaybook,
  createTargetRepo,
  DATA_DRIVEN_PIPELINE,
  waitForGate,
  scriptedAgent,
  type AgentSpec,
} from './kit/index.js';

const stopAt = process.argv[2] ?? 'plan-gate';

const CLEAN_WATCHER: AgentSpec = { byRole: { watcher: { kind: 'domainVerdict', verdict: 'clean' } } };

const h = await createRunHarness({ agent: (sink) => scriptedAgent(CLEAN_WATCHER, sink) });
await givenInstalledPlaybook(h);
const target = createTargetRepo(); // clean throwaway repo; the stub integrator never touches it

const created = await h.api.createRun({
  repo: target.worktree,
  title: 'E2E data-driven recovery run',
  description: 'Group L — data-driven crash-recovery (stubbed agent + integrator).',
  scope: 'data-driven recovery e2e',
  playbookId: 'revisium-agent-playbook',
  pipelineId: DATA_DRIVEN_PIPELINE,
  executionProfile: { runnerOverrides: { 'claude-code': 'stub-agent', 'revo-integrator': 'stub-agent' } },
  start: true,
});
const runId = created.runId;

const plan = await waitForGate(h.api, runId, 'plan');
if (stopAt === 'merge-gate') {
  await h.api.approveGate({ inboxId: plan.inboxId, resolvedBy: 'crash-child' });
  await waitForGate(h.api, runId, 'merge');
}

// Flush the run id, then exit WITHOUT h.close() — no DBOS drain → the workflow stays PENDING (the crash).
process.stdout.write(`RUNID=${runId}\n`, () => process.exit(0));
