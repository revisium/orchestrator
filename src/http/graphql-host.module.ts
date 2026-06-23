import { Module } from '@nestjs/common';
import { GraphqlApiModule } from '../api/graphql-api/graphql-api.module.js';
import { HostLifecycle } from '../host/host.lifecycle.js';
import { TaskControlPlaneModule } from '../task-control-plane/task-control-plane.module.js';

// The daemon serves BOTH front doors (ADR 0006): GraphQL (frontend) + MCP (agents), over one host
// process that is the single DBOS owner. The MCP server is built directly from TaskControlPlaneApi-
// Service (see daemon.ts) — no separate McpModule in the graph.
@Module({
  imports: [TaskControlPlaneModule, GraphqlApiModule],
  providers: [HostLifecycle],
})
export class GraphqlHostModule {}
