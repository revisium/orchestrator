import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/dbos.module.js';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { RunnerModule } from '../runners/runner.module.js';
import { PipelineService } from './develop-task.workflow.js';

/**
 * PipelineModule — registers PipelineService, which registers the developTask
 * workflow + runStep step + dev-tasks queue with DBOS in its constructor.
 *
 * Imports RunnerModule so RUN_AGENT + IntegratorService are injectable.
 *
 * Registration happens at Nest provider-construction time, which precedes
 * HostLifecycle.onApplicationBootstrap() where DBOS.launch() is called — same
 * ordering proven for dev:ping (OQ-4).
 *
 * HOST-ONLY: this module is imported by AppModule (never by the host-free path).
 */
@Module({
  imports: [EngineModule, RevisiumModule, RunnerModule],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
