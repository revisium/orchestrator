













import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import { DbosService } from '../engine/dbos.service.js';
import { ensureStorage } from '../storage/ensure-storage.js';
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
    const storage = await ensureStorage();

    this.dbosService.setConfig(storage.dbosDatabaseUrl, {
      logLevel: isMcpStdioHost() ? 'warn' : undefined,
    });
    await this.dbosService.launch();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dbosService.shutdown();
  }
}
