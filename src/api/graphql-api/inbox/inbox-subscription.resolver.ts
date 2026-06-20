import { Inject } from '@nestjs/common';
import { Args, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { APP_PUB_SUB, INBOX_ITEM_ADDED_TOPIC, INBOX_ITEM_RESOLVED_TOPIC } from '../graphql-ws/constants.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { RunSubscriptionInput } from '../share/inputs/run-subscription.input.js';
import { InboxItemModel } from './model/inbox-item.model.js';

function runFilter(payload: { runId?: string }, variables: { data?: RunSubscriptionInput }) {
  return !variables.data?.runId || payload.runId === variables.data.runId;
}

export class InboxSubscriptionResolver {
  constructor(@Inject(APP_PUB_SUB) private readonly pubSub: PubSub) {}

  @Subscription(() => InboxItemModel, { name: INBOX_ITEM_ADDED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToInboxItemAdded(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(INBOX_ITEM_ADDED_TOPIC);
  }

  @Subscription(() => InboxItemModel, { name: INBOX_ITEM_RESOLVED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToInboxItemResolved(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(INBOX_ITEM_RESOLVED_TOPIC);
  }
}
