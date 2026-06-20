import { Inject } from '@nestjs/common';
import { Args, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { RunSubscriptionInput } from '../share/inputs/run-subscription.input.js';
import {
  APP_PUB_SUB,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_PROGRESS_UPDATED_TOPIC,
  RUN_UPDATED_TOPIC,
} from '../graphql-ws/constants.js';
import { RunCostModel } from './model/run-cost.model.js';
import { RunEventModel } from './model/run-event.model.js';
import { RunProgressModel } from './model/run-progress.model.js';
import { RunModel } from './model/run.model.js';

function runFilter(payload: { runId?: string }, variables: { data?: RunSubscriptionInput }) {
  return !variables.data?.runId || payload.runId === variables.data.runId;
}

export class RunsSubscriptionResolver {
  constructor(@Inject(APP_PUB_SUB) private readonly pubSub: PubSub) {}

  @Subscription(() => RunModel, { name: RUN_UPDATED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunUpdated(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_UPDATED_TOPIC);
  }

  @Subscription(() => RunEventModel, { name: RUN_EVENT_APPENDED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunEventAppended(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_EVENT_APPENDED_TOPIC);
  }

  @Subscription(() => RunProgressModel, { name: RUN_PROGRESS_UPDATED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunProgressUpdated(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_PROGRESS_UPDATED_TOPIC);
  }

  @Subscription(() => RunCostModel, { name: RUN_COST_RECORDED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunCostRecorded(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_COST_RECORDED_TOPIC);
  }
}
