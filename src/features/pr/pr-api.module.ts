import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TaskControlPlaneModule } from '../../task-control-plane/task-control-plane.module.js';
import { prCommandHandlers } from './commands/index.js';
import { PrApiService } from './pr-api.service.js';
import { prQueryHandlers } from './queries/index.js';

@Module({
  imports: [CqrsModule, TaskControlPlaneModule],
  providers: [PrApiService, ...prQueryHandlers, ...prCommandHandlers],
  exports: [PrApiService],
})
export class PrApiModule {}
