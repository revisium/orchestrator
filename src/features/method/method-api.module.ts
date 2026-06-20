import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TaskControlPlaneModule } from '../../task-control-plane/task-control-plane.module.js';
import { methodCommandHandlers } from './commands/index.js';
import { MethodApiService } from './method-api.service.js';
import { methodQueryHandlers } from './queries/index.js';

@Module({
  imports: [CqrsModule, TaskControlPlaneModule],
  providers: [MethodApiService, ...methodQueryHandlers, ...methodCommandHandlers],
  exports: [MethodApiService],
})
export class MethodApiModule {}
