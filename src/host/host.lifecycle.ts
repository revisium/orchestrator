/**
 * HostLifecycle — OnApplicationBootstrap / OnApplicationShutdown.
 *
 * Boot order (§2 of the ТЗ):
 *   1. ensureRevisium() — auto-start if no live daemon; three-state (F7).
 *   2. Pid-proven pg port from the returned runtime (never resolvePorts() — F3).
 *   3. Optional postmaster.pid cross-check (F8).
 *   4. ensurePostgres(provenPgPort) — CREATE DATABASE dbos if absent.
 *   5. dbosService.setConfig(url) + dbosService.launch().
 *
 * Shutdown:
 *   - DBOS.shutdown() only.
 *   - INTENTIONALLY does NOT stop the Revisium daemon (Round 3, human decision):
 *     the daemon is detached+unref'd and is a shared, long-lived process; subsequent
 *     `revo dev:status <id>` invocations must find the same daemon + embedded Postgres.
 */
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { DbosService } from '../engine/dbos.service.js';
import { ensureRevisium, readPostmasterPgPort } from './ensure-revisium.js';
import { dbosSystemDatabaseUrl, ensurePostgres } from '../engine/ensure-postgres.js';
import { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';

function isMcpStdioHost(): boolean {
  return process.env.REVO_MCP_STDIO === '1';
}

function keepControlPlaneBootstrapDependency(_api: TaskControlPlaneApiService | undefined): void {
  // The constructor dependency forces the control-plane provider graph to instantiate
  // before DBOS.launch(); pipeline registration must precede launch.
}

@Injectable()
export class HostLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(DbosService) private readonly dbosService: DbosService,
    @Optional()
    @Inject(TaskControlPlaneApiService)
    taskControlPlaneApi?: TaskControlPlaneApiService,
  ) {
    keepControlPlaneBootstrapDependency(taskControlPlaneApi);
  }

  async onApplicationBootstrap(): Promise<void> {
    // Step 1: Ensure Revisium daemon is running (auto-start if absent).
    const { runtime } = await ensureRevisium();

    // Step 2: Pid-proven pg port (F3 — never resolvePorts()).
    let provenPgPort = runtime.pgPort;

    // Optional cross-check against postmaster.pid (F8).
    if (runtime.dataDir) {
      const pmPort = readPostmasterPgPort(runtime.dataDir);
      if (pmPort !== null && pmPort !== runtime.pgPort) {
        throw new Error(
          `Stale runtime.json: runtime.pgPort=${runtime.pgPort} but postmaster.pid reports port=${pmPort}. ` +
            'Restart Revisium: revo revisium stop && revo revisium start',
        );
      }
      if (pmPort !== null) {
        provenPgPort = pmPort;
      }
    }
    // If runtime.dataDir is absent (older standalone), skip cross-check and rely on rt.pgPort.

    // Step 3: Ensure the `dbos` database exists.
    await ensurePostgres(provenPgPort);

    // Step 4+5: Configure + launch DBOS.
    this.dbosService.setConfig(dbosSystemDatabaseUrl(provenPgPort), {
      logLevel: isMcpStdioHost() ? 'warn' : undefined,
    });
    await this.dbosService.launch();
  }

  async onApplicationShutdown(): Promise<void> {
    // Intentional: host does not own the Revisium daemon lifecycle.
    // Only DBOS.shutdown() runs on exit.
    // The daemon was spawned detached+unref'd and must outlive the host process.
    await this.dbosService.shutdown();
  }
}
