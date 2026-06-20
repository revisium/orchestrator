import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TaskControlPlaneModule } from '../../task-control-plane/task-control-plane.module.js';
import { runsCommandHandlers } from './commands/index.js';
import { runsQueryHandlers } from './queries/index.js';
import { RunsApiService } from './runs-api.service.js';

@Module({
  imports: [CqrsModule, TaskControlPlaneModule],
  providers: [RunsApiService, ...runsQueryHandlers, ...runsCommandHandlers],
  exports: [RunsApiService],
})
export class RunsApiModule {}
