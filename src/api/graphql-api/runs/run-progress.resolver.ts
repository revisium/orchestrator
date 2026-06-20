import { Inject } from '@nestjs/common';
import { Args, ID, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { RunProgressModel } from './model/run-progress.model.js';
import { RunModel } from './model/run.model.js';

@Resolver(() => RunModel)
export class RunProgressResolver {
  constructor(@Inject(RunsApiService) private readonly api: RunsApiService) {}

  @Query(() => RunProgressModel)
  @GraphqlParamTypes(String)
  runProgress(@Args('id', { type: () => ID }) id: string) {
    return this.api.getRunProgress({ runId: id });
  }

  @ResolveField(() => RunProgressModel)
  @GraphqlParamTypes(RunModel)
  progress(@Parent() run: RunModel) {
    return this.api.getRunProgress({ runId: run.id });
  }
}
