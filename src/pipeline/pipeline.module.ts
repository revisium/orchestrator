import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/dbos.module.js';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { RunnerModule } from '../runners/runner.module.js';
import { PipelineService } from './pipeline.service.js';











@Module({
  imports: [EngineModule, RevisiumModule, RunnerModule],
  providers: [PipelineService],
  exports: [PipelineService],
})
export class PipelineModule {}
