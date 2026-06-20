import { Inject } from '@nestjs/common';
import { Args, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { RunEventConnection } from './model/run-event-connection.model.js';
import { RunModel } from './model/run.model.js';

@Resolver(() => RunModel)
export class RunEventsResolver {
  constructor(@Inject(RunsApiService) private readonly api: RunsApiService) {}

  @ResolveField(() => RunEventConnection)
  @GraphqlParamTypes(RunModel, String, Number, String)
  events(
    @Parent() run: RunModel,
    @Args('type', { type: () => String, nullable: true }) type?: string,
    @Args('first', { type: () => Int, defaultValue: 50 }) first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ) {
    return this.api.getRunEvents({ runId: run.id, type, first, after });
  }
}
