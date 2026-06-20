import { Inject } from '@nestjs/common';
import { Query, Resolver } from '@nestjs/graphql';
import { TaskControlPlaneApiService } from '../../../task-control-plane/task-control-plane-api.service.js';
import { SystemStatusModel } from './model/system-status.model.js';

@Resolver(() => SystemStatusModel)
export class SystemResolver {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  @Query(() => SystemStatusModel)
  status() {
    return this.api.getStatus();
  }
}
