import 'reflect-metadata';
import { HostLifecycle } from '../../host/host.lifecycle.js';
import { DbosService } from '../../engine/dbos.service.js';
import { createClientTransport } from '../../control-plane/client-transport.js';
import { RolesService } from '../../revisium/roles.service.js';
import { RunService } from '../../revisium/run.service.js';
import { InboxService } from '../../revisium/inbox.service.js';
import { PlaybooksService } from '../../revisium/playbooks.service.js';
import { PipelineService } from '../../pipeline/develop-task.workflow.js';
import { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import type { RunAgent } from '../../worker/runner.js';
import type { ExecGhFn } from '../../poller/pr-readiness.js';
import { deterministicAgent, type AgentCall, type DeveloperWrites } from './agents.js';
import { createGhEmulator, type GhScenario } from './gh-emulator.js';
import { createFakeIntegrator } from './fake-integrator.js';

export type RunHarnessOptions = {
  /** Override the agent. Default: {@link deterministicAgent} recording into `agentCalls`/`developerWrites`. */
  agent?: RunAgent;
  /** gh behaviour (see {@link GhScenario}) or a ready `ExecGhFn`. Default: `'happy'` recording into `ghCalls`. */
  gh?: GhScenario | ExecGhFn;
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
    typeof opts.gh === 'function' ? opts.gh : createGhEmulator(ghCalls, opts.gh);
  const integrator = createFakeIntegrator(runs, execGh);
  const agent = opts.agent ?? deterministicAgent(agentCalls, developerWrites);

  const pipeline = new PipelineService(dbos, roles, runs, inbox, integrator, agent);
  const api = new TaskControlPlaneApiService(runs, inbox, roles, playbooks, pipeline, dbos);

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
