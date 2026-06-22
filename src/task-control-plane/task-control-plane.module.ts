import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { getConfig } from '../cli/config.js';
import { DbosService } from '../engine/dbos.service.js';
import { AgentObservabilityService } from '../observability/agent-observability.service.js';
import { PipelineModule } from '../pipeline/pipeline.module.js';
import { RevisiumModule } from '../revisium/revisium.module.js';
import { RunService } from '../revisium/run.service.js';
import { PrReadinessService } from './pr-readiness.service.js';
import { TaskControlPlaneApiService } from './task-control-plane-api.service.js';

@Module({
  imports: [RevisiumModule, PipelineModule],
  providers: [
    TaskControlPlaneApiService,
    PrReadinessService,
    {
      provide: AgentObservabilityService,
      inject: [RunService, DbosService],
      useFactory: (runs: RunService, dbos: DbosService) =>
        new AgentObservabilityService({
          artifactRoot: join(getConfig().dataDir, 'run-artifacts'),
          runExists: async (id) => Boolean(await runs.getRun(id)),
          dbos: {
            getEvent: (workflowID, key, opts) => dbos.getEvent(workflowID, key, opts),
            readStream: (workflowID, key) => dbos.readStream(workflowID, key),
          },
        }),
    },
  ],
  exports: [TaskControlPlaneApiService],
})
export class TaskControlPlaneModule {}
