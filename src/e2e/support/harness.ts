import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { EngineApiService } from '@revisium/engine';
import { bootstrapEngineControlPlane } from '../../control-plane/bootstrap.js';
import { HostLifecycle } from '../../host/host.lifecycle.js';
import { DbosService } from '../../engine/dbos.service.js';
import { getConfig } from '../../cli/config.js';
import { AgentObservabilityService } from '../../observability/agent-observability.service.js';
import { RolesService } from '../../revisium/roles.service.js';
import { RunService } from '../../revisium/run.service.js';
import { InboxService } from '../../revisium/inbox.service.js';
import { PlaybooksService } from '../../revisium/playbooks.service.js';
import { RevisiumModule } from '../../revisium/revisium.module.js';
import { RevoPrismaService } from '../../storage/revo-prisma.service.js';
import { ensureStorage } from '../../storage/ensure-storage.js';
import { PipelineService } from '../../pipeline/pipeline.service.js';
import { AGENT_OUTPUT_STREAM_PREFIX, type AgentOutputEvent } from '../../observability/types.js';
import { WorktreeService } from '../../runners/worktree.service.js';
import { worktreePathFor } from '../../control-plane/resolve-cwd.js';
import { TaskControlPlaneApiService } from '../../task-control-plane/task-control-plane-api.service.js';
import { plannedAgent, type AgentCall, type AgentSink } from './agents.js';
import { plannedGhEmulator } from './gh-emulator.js';
import { createFakeIntegrator, plannedIntegrator } from './fake-integrator.js';
import { CasePlanRegistry, type ControlledCasePlan } from './case-plan.js';

export type HostFixtureOptions = {
  /** Immutable task plans that must be visible before DBOS recovery starts during host bootstrap. */
  initialCasePlans?: readonly Readonly<{ taskId: string; plan: ControlledCasePlan }>[];
};

export type HostFixture = {
  /** Support-internal product API; layer contexts translate it into their approved operations. */
  api: TaskControlPlaneApiService;
  dbos: DbosService;
  lifecycle: HostLifecycle;
  context: INestApplicationContext;
  casePlans: CasePlanRegistry;
  agentCalls: AgentCall[];
  ghCalls: string[][];
  armAgentOutputFirstWriteBarrier: (parties?: number) => void;
  /**
   * Shut the file-local DBOS runtime down. The suite-level host daemon owns embedded Postgres.
   * `keepWorkflowsParked` skips the DBOS-level workflow cancel sweep — only for tests whose
   * subject IS a workflow parked across teardown (teardown-drain).
   */
  close: (opts?: { keepWorkflowsParked?: boolean }) => Promise<void>;
};

/**
 * Boot the real control-plane services (DBOS + embedded Revisium engine) with only the agent and `gh` faked.
 * Mirrors the wiring of the production `RevisiumModule` closely enough that the returned `api` behaves
 * like the live MCP/CLI surface. Always pair with `harness.close()` in a `finally` block.
 */
export async function createHostFixture(opts: HostFixtureOptions = {}): Promise<HostFixture> {
  await ensureStorage();
  const context = await NestFactory.createApplicationContext(RevisiumModule, { logger: ['error', 'warn'] });
  if (process.env['REVO_E2E_HARNESS_BOOTSTRAP'] === '1') {
    const engine = context.get(EngineApiService, { strict: false });
    const prisma = context.get(RevoPrismaService, { strict: false });
    await bootstrapEngineControlPlane(engine, prisma);
  }
  const dbos = new DbosService();
  const realWriteStream = dbos.writeStream.bind(dbos);
  type PendingWrite = {
    key: string;
    value: AgentOutputEvent;
    resolve: () => void;
    reject: (error: unknown) => void;
  };
  type WriteBarrier = {
    parties: number;
    pending: Map<string, PendingWrite>;
    timer: ReturnType<typeof setTimeout>;
  };
  let writeBarrier: WriteBarrier | undefined;
  const armAgentOutputFirstWriteBarrier = (parties = 2): void => {
    if (!Number.isInteger(parties) || parties < 1) throw new Error(`invalid agent output barrier parties: ${parties}`);
    if (writeBarrier) throw new Error('agent output first-write barrier is already armed');
    const pending = new Map<string, PendingWrite>();
    const timer = setTimeout(() => {
      const barrier = writeBarrier;
      if (!barrier) return;
      writeBarrier = undefined;
      const error = new Error(
        `agent output first-write barrier timed out after 7500ms: received ${barrier.pending.size}/${barrier.parties} distinct attempts`,
      );
      for (const entry of barrier.pending.values()) entry.reject(error);
    }, 7500);
    writeBarrier = { parties, pending, timer };
  };
  dbos.writeStream = async <T>(key: string, value: T): Promise<void> => {
    const barrier = writeBarrier;
    const event = value as AgentOutputEvent;
    if (
      !barrier ||
      !(key === 'agent-output' || key.startsWith(AGENT_OUTPUT_STREAM_PREFIX) || key === 'agent-output-v1') ||
      event?.attemptSeq !== 1 ||
      typeof event.attemptId !== 'string'
    ) {
      return realWriteStream(key, value);
    }
    const existing = barrier.pending.get(event.attemptId);
    if (existing) {
      return new Promise<void>((resolve, reject) => {
        const originalResolve = existing.resolve;
        const originalReject = existing.reject;
        existing.resolve = () => {
          originalResolve();
          resolve();
        };
        existing.reject = (error) => {
          originalReject(error);
          reject(error);
        };
      });
    }
    const promise = new Promise<void>((resolve, reject) => {
      barrier.pending.set(event.attemptId, { key, value: event, resolve, reject });
    });
    if (barrier.pending.size === barrier.parties) {
      writeBarrier = undefined;
      clearTimeout(barrier.timer);
      const writes = [...barrier.pending.values()].map((entry) => realWriteStream(entry.key, entry.value));
      Promise.all(writes).then(
        () => barrier.pending.forEach((entry) => entry.resolve()),
        (error) => barrier.pending.forEach((entry) => entry.reject(error)),
      );
    }
    return promise;
  };
  const lifecycle = new HostLifecycle(dbos);
  const roles = context.get(RolesService, { strict: false });
  const runs = context.get(RunService, { strict: false });
  const inbox = context.get(InboxService, { strict: false });
  const playbooks = context.get(PlaybooksService, { strict: false });

  const ghCalls: string[][] = [];
  const agentCalls: AgentCall[] = [];
  const casePlans = new CasePlanRegistry();
  for (const initial of opts.initialCasePlans ?? []) casePlans.register(initial.taskId, initial.plan);
  const sink: AgentSink = { agentCalls, casePlans };

  const execGh = plannedGhEmulator(casePlans, ghCalls);
  const baseIntegrator = createFakeIntegrator(runs, execGh);
  const integrator = plannedIntegrator(casePlans, baseIntegrator);
  const agent = plannedAgent(sink);

  const worktrees = new WorktreeService(runs);
  const baseRelease = worktrees.release.bind(worktrees);
  worktrees.release = async (runId, taskId) => {
    const cleanup = casePlans.get(taskId)?.cleanup;
    if (cleanup?.releaseWorktreeFails) throw new Error('forced cleanup release failure');
    if (cleanup?.dirtyWorktreeBeforeRelease) {
      writeFileSync(join(worktreePathFor(getConfig().dataDir, runId), 'dirty-before-release.txt'), 'preserve worktree\n');
    }
    return baseRelease(runId, taskId);
  };
  const pipeline = new PipelineService(dbos, roles, runs, inbox, integrator, worktrees, agent);
  const observability = new AgentObservabilityService({
    artifactRoot: join(getConfig().dataDir, 'run-artifacts'),
    runExists: async (id) => Boolean(await runs.getRun(id)),
    listAgentOutputStreamRegistrations: (id) => runs.listAgentOutputStreamRegistrations(id),
    runStatus: async (id) => {
      const run = await runs.getRun(id);
      return typeof run?.data.status === 'string' ? run.data.status : undefined;
    },
    dbos: {
      getEvent: (workflowID, key, opts) => dbos.getEvent(workflowID, key, opts),
      readStream: (workflowID, key) => dbos.readStream(workflowID, key),
    },
  });
  const api = new TaskControlPlaneApiService(runs, inbox, roles, playbooks, pipeline, dbos, observability);

  try {
    await lifecycle.onApplicationBootstrap();
  } catch (error) {
    await context.close();
    throw error;
  }

  let closed = false;

  return {
    api,
    dbos,
    lifecycle,
    context,
    casePlans,
    agentCalls,
    ghCalls,
    armAgentOutputFirstWriteBarrier,
    close: async (opts?: { keepWorkflowsParked?: boolean }): Promise<void> => {
      if (closed) return;
      closed = true;
      // Teardown cancels this file's leftover DBOS workflows: a workflow parked at a gate stays
      // PENDING forever (cancelRun never cancels the workflow), would be recovered by this file's
      // next boot (crash-recovery scenarios), and holds a dev-tasks concurrency slot. The sweep is
      // scoped to this FILE's DBOS system db (REVO_DBOS_DB is per-file), so it can never touch a
      // concurrently running file. Do NOT cancel run ROWS here: the control-plane is shared across
      // files, so a row-level `listRuns → cancelRun` sweep murders neighbours' live runs when files
      // run in parallel — and it is unnecessary, the home is wiped by e2e-setup every suite run.
      if (!opts?.keepWorkflowsParked) {
        try {
          const active = await dbos.listWorkflows({ status: ['PENDING', 'ENQUEUED'], limit: 500 });
          const ids = active.map((wf) => wf.workflowID);
          if (ids.length > 0) await dbos.cancelWorkflows(ids);
        } catch {
          // best-effort cleanup — teardown must never throw
        }
      }
      try {
        await lifecycle.onApplicationShutdown();
      } finally {
        await context.close();
      }
    },
  };
}
