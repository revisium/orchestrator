import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TaskControlPlaneModule } from '../../task-control-plane/task-control-plane.module.js';
import { systemCommandHandlers } from './commands/index.js';
import { SystemApiService } from './system-api.service.js';
import { systemQueryHandlers } from './queries/index.js';

@Module({
  imports: [CqrsModule, TaskControlPlaneModule],
  providers: [SystemApiService, ...systemQueryHandlers, ...systemCommandHandlers],
  exports: [SystemApiService],
})
export class SystemApiModule {}
