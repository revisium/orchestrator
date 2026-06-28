













import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { DbosService } from '../engine/dbos.service.js';
import { ensureRevisium, readPostmasterPgPort } from './ensure-revisium.js';
import { dbosSystemDatabaseUrl, ensurePostgres } from '../engine/ensure-postgres.js';
import { TaskControlPlaneApiService } from '../task-control-plane/task-control-plane-api.service.js';

function isMcpStdioHost(): boolean {
  return process.env.REVO_MCP_STDIO === '1';
}

function keepControlPlaneBootstrapDependency(_api: TaskControlPlaneApiService | undefined): void {
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
    const { runtime } = await ensureRevisium();

    let provenPgPort = runtime.pgPort;

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

    await ensurePostgres(provenPgPort);

    this.dbosService.setConfig(dbosSystemDatabaseUrl(provenPgPort), {
      logLevel: isMcpStdioHost() ? 'warn' : undefined,
    });
    await this.dbosService.launch();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dbosService.shutdown();
  }
}
