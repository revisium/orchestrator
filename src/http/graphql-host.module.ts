import { Module } from '@nestjs/common';
import { GraphqlApiModule } from '../api/graphql-api/graphql-api.module.js';
import { SystemResolver } from '../api/graphql-api/system/system.resolver.js';
import { HostLifecycle } from '../host/host.lifecycle.js';
import { TaskControlPlaneModule } from '../task-control-plane/task-control-plane.module.js';

@Module({
  imports: [TaskControlPlaneModule, GraphqlApiModule],
  providers: [HostLifecycle, SystemResolver],
})
export class GraphqlHostModule {}
