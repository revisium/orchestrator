import { Inject } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import { PrApiService } from '../../../features/pr/pr-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { PrReadinessInput } from './inputs/pr-readiness.input.js';

@Resolver()
export class PrResolver {
  constructor(@Inject(PrApiService) private readonly api: PrApiService) {}

  @Query(() => GraphQLJSON)
  @GraphqlParamTypes(PrReadinessInput)
  prReadiness(@Args('data', { type: () => PrReadinessInput }) data: PrReadinessInput) {
    return this.api.prReadiness(data);
  }

  @Query(() => GraphQLJSON)
  @GraphqlParamTypes(PrReadinessInput)
  prFeedback(@Args('data', { type: () => PrReadinessInput }) data: PrReadinessInput) {
    return this.api.prFeedback(data);
  }
}
