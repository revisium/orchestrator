import 'reflect-metadata';
import { join } from 'node:path';
import { HostLifecycle } from '../../host/host.lifecycle.js';
import { DbosService } from '../../engine/dbos.service.js';
import { getConfig } from '../../cli/config.js';
import { createClientTransport } from '../../control-plane/client-transport.js';
import { AgentObservabilityService } from '../../observability/agent-observability.service.js';
import { RolesService } from '../../revisium/roles.service.js';
import { RunService } from '../../revisium/run.service.js';
import { InboxService } from '../../revisium/inbox.service.js';
import { PlaybooksService } from '../../revisium/playbooks.service.js';
import { PipelineService } from '../../pipeline/pipeline.service.js';
import { WorktreeService } from '../../runners/worktree.service.js';
import { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import type { RunAgent } from '../../worker/runner.js';
import type { IntegratorService } from '../../runners/integrator.js';
import type { ExecGhFn } from '../../poller/pr-readiness.js';
import { deterministicAgent, type AgentCall, type AgentSink, type DeveloperWrites } from './agents.js';
import { createGhEmulator, type GhScenario } from './gh-emulator.js';
import { createFakeIntegrator } from './fake-integrator.js';

export type RunHarnessOptions = {
  /**
   * Override the agent via a factory that receives the harness recorders (so a custom agent records
   * into the same `agentCalls`/`developerWrites`). Default: {@link deterministicAgent}.
   */
  agent?: (sink: AgentSink) => RunAgent;
  /**
   * gh behaviour: a {@link GhScenario} string, or a factory that receives the harness `ghCalls`
   * recorder (e.g. `routedGhEmulator` for per-run scenarios). Default: `'happy'`.
   */
  gh?: GhScenario | ((ghCalls: string[][]) => ExecGhFn);
  /** Wrap the (fake) integrator — e.g. `routedIntegrator` for per-run mocked integrate outcomes. */
  integrator?: (base: IntegratorService) => IntegratorService;
};

export type RunHarness = {
  /** The same surface MCP and the CLI drive — tests exercise the real external API. */
  api: TaskControlPlaneApiService;
  dbos: DbosService;
  lifecycle: HostLifecycle;
  /** Recorded agent invocations (populated by the default {@link deterministicAgent}). */
  agentCalls: AgentCall[];
  /** runId → worktree where the developer role writes a change (so the real integrator has a diff). */
  developerWrites: DeveloperWrites;
  /** Recorded `gh` argv (populated by the default emulator). */
  ghCalls: string[][];
  /** Shut the host down (DBOS drain); the standalone daemon is intentionally left running. */
  close: () => Promise<void>;
};

/**
 * Boot the real host (DBOS + Revisium standalone + Postgres) with only the agent and `gh` faked.
 * Mirrors the wiring of the production `AppModule` closely enough that the returned `api` behaves
 * like the live MCP/CLI surface. Always pair with `harness.close()` (or {@link closeHarness}) in a
 * `finally` block.
 */
export async function createRunHarness(opts: RunHarnessOptions = {}): Promise<RunHarness> {
  const dbos = new DbosService();
  const lifecycle = new HostLifecycle(dbos);
  const draft = createClientTransport('draft');
  const head = createClientTransport('head');
  const roles = new RolesService(head);
  const runs = new RunService(draft);
  const inbox = new InboxService(draft);
  const playbooks = new PlaybooksService(head);

  const ghCalls: string[][] = [];
  const agentCalls: AgentCall[] = [];
  const developerWrites: DeveloperWrites = new Map();

  const execGh: ExecGhFn =
    typeof opts.gh === 'function' ? opts.gh(ghCalls) : createGhEmulator(ghCalls, opts.gh);
  const baseIntegrator = createFakeIntegrator(runs, execGh);
  const integrator = opts.integrator ? opts.integrator(baseIntegrator) : baseIntegrator;
  const agent = opts.agent
    ? opts.agent({ agentCalls, developerWrites })
    : deterministicAgent(agentCalls, developerWrites);

  const worktrees = new WorktreeService(runs);
  const pipeline = new PipelineService(dbos, roles, runs, inbox, integrator, worktrees, agent);
  const observability = new AgentObservabilityService({
    artifactRoot: join(getConfig().dataDir, 'run-artifacts'),
    runExists: async (id) => Boolean(await runs.getRun(id)),
    dbos: {
      getEvent: (workflowID, key, opts) => dbos.getEvent(workflowID, key, opts),
      readStream: (workflowID, key) => dbos.readStream(workflowID, key),
    },
  });
  const api = new TaskControlPlaneApiService(runs, inbox, roles, playbooks, pipeline, dbos, observability);

  await lifecycle.onApplicationBootstrap();

  return {
    api,
    dbos,
    lifecycle,
    agentCalls,
    developerWrites,
    ghCalls,
    close: async (): Promise<void> => {
      await lifecycle.onApplicationShutdown();
    },
  };
}

/** Null-safe teardown, for symmetry with `try { … } finally { await closeHarness(h); }`. */
export async function closeHarness(harness: RunHarness | null): Promise<void> {
  if (!harness) return;
  await harness.close();
}
