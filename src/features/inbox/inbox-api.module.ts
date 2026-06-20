import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TaskControlPlaneModule } from '../../task-control-plane/task-control-plane.module.js';
import { inboxCommandHandlers } from './commands/index.js';
import { InboxApiService } from './inbox-api.service.js';
import { inboxQueryHandlers } from './queries/index.js';

@Module({
  imports: [CqrsModule, TaskControlPlaneModule],
  providers: [InboxApiService, ...inboxQueryHandlers, ...inboxCommandHandlers],
  exports: [InboxApiService],
})
export class InboxApiModule {}
