import { Module } from '@nestjs/common';
import { TaskControlPlaneModule } from '../task-control-plane/task-control-plane.module.js';
import { McpFacadeService } from './mcp-facade.service.js';

@Module({
  imports: [TaskControlPlaneModule],
  providers: [McpFacadeService],
  exports: [McpFacadeService],
})
export class McpModule {}
