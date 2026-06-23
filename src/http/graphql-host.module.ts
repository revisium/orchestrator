import { Module } from '@nestjs/common';
import { GraphqlApiModule } from '../api/graphql-api/graphql-api.module.js';
import { HostLifecycle } from '../host/host.lifecycle.js';
import { McpModule } from '../mcp/mcp.module.js';
import { TaskControlPlaneModule } from '../task-control-plane/task-control-plane.module.js';

// The daemon serves BOTH front doors (ADR 0006): GraphQL (frontend) + MCP (agents), over one host
// process that is the single DBOS owner. McpModule gives the daemon McpHttpService for `revo mcp`.
@Module({
  imports: [TaskControlPlaneModule, GraphqlApiModule, McpModule],
  providers: [HostLifecycle],
})
export class GraphqlHostModule {}
