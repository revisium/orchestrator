import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { MethodApiService } from '../../../features/method/method-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { CreateRunProfileInput } from './inputs/create-run-profile.input.js';
import { DeprecateRunProfileInput } from './inputs/deprecate-run-profile.input.js';
import { GetRunProfileInput } from './inputs/get-run-profile.input.js';
import { ListMethodInput } from './inputs/list-method.input.js';
import { ListRunProfilesInput } from './inputs/list-run-profiles.input.js';
import { UpdateRunProfileInput } from './inputs/update-run-profile.input.js';
import { ValidateRunProfileInput } from './inputs/validate-run-profile.input.js';
import { PipelineConnection } from './model/pipeline-connection.model.js';
import { PipelineModel } from './model/pipeline.model.js';
import { PlaybookConnection } from './model/playbook-connection.model.js';
import { RoleConnection } from './model/role-connection.model.js';
import { RoleModel } from './model/role.model.js';
import { RunProfileConnection } from './model/run-profile-connection.model.js';
import { RunProfileModel } from './model/run-profile.model.js';

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

  @Query(() => RunProfileConnection)
  @GraphqlParamTypes(ListRunProfilesInput)
  runProfiles(@Args('data', { type: () => ListRunProfilesInput, nullable: true }) data?: ListRunProfilesInput) {
    return this.api.listRunProfiles(data ?? { first: 50 });
  }

  @Query(() => RunProfileModel)
  @GraphqlParamTypes(GetRunProfileInput)
  runProfile(@Args('data', { type: () => GetRunProfileInput }) data: GetRunProfileInput) {
    return this.api.getRunProfile(data);
  }

  @Query(() => GraphQLJSON)
  @GraphqlParamTypes(ValidateRunProfileInput)
  validateRunProfile(@Args('data', { type: () => ValidateRunProfileInput }) data: ValidateRunProfileInput) {
    return this.api.validateRunProfile(data);
  }

  @Mutation(() => RunProfileModel)
  @GraphqlParamTypes(CreateRunProfileInput)
  createRunProfile(@Args('data', { type: () => CreateRunProfileInput }) data: CreateRunProfileInput) {
    return this.api.createRunProfile(data);
  }

  @Mutation(() => RunProfileModel)
  @GraphqlParamTypes(UpdateRunProfileInput)
  updateRunProfile(@Args('data', { type: () => UpdateRunProfileInput }) data: UpdateRunProfileInput) {
    return this.api.updateRunProfile(data);
  }

  @Mutation(() => RunProfileModel)
  @GraphqlParamTypes(DeprecateRunProfileInput)
  deprecateRunProfile(@Args('data', { type: () => DeprecateRunProfileInput }) data: DeprecateRunProfileInput) {
    return this.api.deprecateRunProfile(data);
  }
}
