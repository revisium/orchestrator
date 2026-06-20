import { Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { MethodApiService } from '../../../features/method/method-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { ListMethodInput } from './inputs/list-method.input.js';
import { PipelineConnection } from './model/pipeline-connection.model.js';
import { PipelineModel } from './model/pipeline.model.js';
import { PlaybookConnection } from './model/playbook-connection.model.js';
import { RoleConnection } from './model/role-connection.model.js';
import { RoleModel } from './model/role.model.js';

@Resolver()
export class MethodResolver {
  constructor(@Inject(MethodApiService) private readonly api: MethodApiService) {}

  @Query(() => RoleConnection)
  @GraphqlParamTypes(ListMethodInput)
  roles(@Args('data', { type: () => ListMethodInput, nullable: true }) data?: ListMethodInput) {
    return this.api.listRoles(data ?? {});
  }

  @Query(() => RoleModel)
  @GraphqlParamTypes(String)
  role(@Args('id', { type: () => ID }) id: string) {
    return this.api.getRole({ roleId: id });
  }

  @Query(() => PlaybookConnection)
  @GraphqlParamTypes(ListMethodInput)
  playbooks(@Args('data', { type: () => ListMethodInput, nullable: true }) data?: ListMethodInput) {
    return this.api.listPlaybooks(data ?? {});
  }

  @Query(() => PipelineConnection)
  @GraphqlParamTypes(ListMethodInput)
  pipelines(@Args('data', { type: () => ListMethodInput, nullable: true }) data?: ListMethodInput) {
    return this.api.listPipelines(data ?? {});
  }

  @Query(() => PipelineModel)
  @GraphqlParamTypes(String)
  pipeline(@Args('id', { type: () => ID }) id: string) {
    return this.api.getPipeline({ pipelineId: id });
  }
}
