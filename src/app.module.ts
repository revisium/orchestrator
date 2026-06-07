import { Module } from '@nestjs/common';
import { EngineModule } from './engine/dbos.module.js';
import { PipelineModule } from './pipeline/pipeline.module.js';
import { HostLifecycle } from './host/host.lifecycle.js';

/**
 * Root NestJS module for the agent-orchestrator host.
 *
 * PipelineModule is imported so PipelineService is constructed (and registers
 * its DBOS workflow/step/queue) BEFORE HostLifecycle.onApplicationBootstrap()
 * calls dbosService.launch() — required by DBOS recovery (OQ-4).
 */
@Module({
  imports: [EngineModule, PipelineModule],
  providers: [HostLifecycle],
})
export class AppModule {}
