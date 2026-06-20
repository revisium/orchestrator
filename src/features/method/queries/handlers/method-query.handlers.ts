import { Inject } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { TaskControlPlaneApiService } from '../../../../task-control-plane/task-control-plane-api.service.js';
import { toConnection } from '../../../shared/connection.js';
import { GetPipelineQuery } from '../impl/get-pipeline.query.js';
import { GetRoleQuery } from '../impl/get-role.query.js';
import { ListPipelinesQuery } from '../impl/list-pipelines.query.js';
import { ListPlaybooksQuery } from '../impl/list-playbooks.query.js';
import { ListRolesQuery } from '../impl/list-roles.query.js';

type RoleLike = {
  id?: string;
  name: string;
  modelLevel: string;
  runner: string;
};

type PipelineLike = {
  alternativeRoles: Array<{ group_id: string; roles: string[]; resolution: string }>;
};

function roleId(role: RoleLike): string {
  return role.id ?? role.name;
}

function mapRole<T extends RoleLike>(role: T) {
  return { id: roleId(role), ...role };
}

function mapPipeline<T extends PipelineLike>(pipeline: T) {
  return {
    ...pipeline,
    alternativeRoles: pipeline.alternativeRoles.map((group) => ({
      groupId: group.group_id,
      roles: group.roles,
      resolution: group.resolution,
    })),
  };
}

@QueryHandler(ListRolesQuery)
export class ListRolesHandler implements IQueryHandler<ListRolesQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListRolesQuery) {
    const roles = await this.api.listRoles();
    return toConnection(roles.map(mapRole), query.data);
  }
}

@QueryHandler(GetRoleQuery)
export class GetRoleHandler implements IQueryHandler<GetRoleQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetRoleQuery) {
    return mapRole(await this.api.getRole(query.data.roleId));
  }
}

@QueryHandler(ListPlaybooksQuery)
export class ListPlaybooksHandler implements IQueryHandler<ListPlaybooksQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListPlaybooksQuery) {
    return toConnection(await this.api.listPlaybooks(), query.data);
  }
}

@QueryHandler(ListPipelinesQuery)
export class ListPipelinesHandler implements IQueryHandler<ListPipelinesQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: ListPipelinesQuery) {
    const pipelines = await this.api.listPipelines();
    return toConnection(pipelines.map(mapPipeline), query.data);
  }
}

@QueryHandler(GetPipelineQuery)
export class GetPipelineHandler implements IQueryHandler<GetPipelineQuery> {
  constructor(@Inject(TaskControlPlaneApiService) private readonly api: TaskControlPlaneApiService) {}

  async execute(query: GetPipelineQuery) {
    return mapPipeline(await this.api.getPipeline(query.data.pipelineId));
  }
}
