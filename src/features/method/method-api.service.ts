import { Inject, Injectable } from '@nestjs/common';
import { QueryBus } from '@nestjs/cqrs';
import { GetPipelineQuery, type GetPipelineQueryData } from './queries/impl/get-pipeline.query.js';
import { GetRoleQuery, type GetRoleQueryData } from './queries/impl/get-role.query.js';
import { ListPipelinesQuery, type ListPipelinesQueryData } from './queries/impl/list-pipelines.query.js';
import { ListPlaybooksQuery, type ListPlaybooksQueryData } from './queries/impl/list-playbooks.query.js';
import { ListRolesQuery, type ListRolesQueryData } from './queries/impl/list-roles.query.js';

@Injectable()
export class MethodApiService {
  constructor(@Inject(QueryBus) private readonly queryBus: QueryBus) {}

  listRoles(data: ListRolesQueryData) {
    return this.queryBus.execute(new ListRolesQuery(data));
  }

  getRole(data: GetRoleQueryData) {
    return this.queryBus.execute(new GetRoleQuery(data));
  }

  listPlaybooks(data: ListPlaybooksQueryData) {
    return this.queryBus.execute(new ListPlaybooksQuery(data));
  }

  listPipelines(data: ListPipelinesQueryData) {
    return this.queryBus.execute(new ListPipelinesQuery(data));
  }

  getPipeline(data: GetPipelineQueryData) {
    return this.queryBus.execute(new GetPipelineQuery(data));
  }
}
