import { Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { RunsApiService } from '../../../features/runs/runs-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { GetRunEventsInput } from './inputs/get-run-events.input.js';
import { ListRunsInput } from './inputs/list-runs.input.js';
import { SimulateRouteInput } from './inputs/simulate-route.input.js';
import { RunConnection } from './model/run-connection.model.js';
import { RunDigestModel } from './model/run-digest.model.js';
import { RunEventConnection } from './model/run-event-connection.model.js';
import { RunModel } from './model/run.model.js';

@Resolver(() => RunModel)
export class RunsResolver {
  constructor(@Inject(RunsApiService) private readonly api: RunsApiService) {}

  @Query(() => RunConnection)
  @GraphqlParamTypes(ListRunsInput)
  runs(@Args('data', { type: () => ListRunsInput, nullable: true }) data?: ListRunsInput) {
    return this.api.listRuns(data ?? {});
  }

  @Query(() => RunModel)
  @GraphqlParamTypes(String)
  run(@Args('id', { type: () => ID }) id: string) {
    return this.api.getRun({ runId: id });
  }

  @Query(() => RunEventConnection)
  @GraphqlParamTypes(GetRunEventsInput)
  runEvents(@Args('data', { type: () => GetRunEventsInput }) data: GetRunEventsInput) {
    return this.api.getRunEvents(data);
  }

  @Query(() => RunDigestModel)
  @GraphqlParamTypes(String)
  runDigest(@Args('id', { type: () => ID }) id: string) {
    return this.api.getRunDigest({ runId: id });
  }

  @Query(() => GraphQLJSON)
  @GraphqlParamTypes(SimulateRouteInput)
  simulateRoute(@Args('data', { type: () => SimulateRouteInput }) data: SimulateRouteInput) {
    return this.api.simulateRoute(data);
  }
}
