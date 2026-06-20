import { Inject } from '@nestjs/common';
import { Args, ID, Query, Resolver } from '@nestjs/graphql';
import { InboxApiService } from '../../../features/inbox/inbox-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { ListInboxInput } from './inputs/list-inbox.input.js';
import { GateRiskModel } from './model/gate-risk.model.js';
import { InboxConnection } from './model/inbox-connection.model.js';
import { InboxItemModel } from './model/inbox-item.model.js';

@Resolver(() => InboxItemModel)
export class InboxResolver {
  constructor(@Inject(InboxApiService) private readonly api: InboxApiService) {}

  @Query(() => InboxConnection)
  @GraphqlParamTypes(ListInboxInput)
  inbox(@Args('data', { type: () => ListInboxInput, nullable: true }) data?: ListInboxInput) {
    return this.api.listInbox(data ?? {});
  }

  @Query(() => InboxItemModel)
  @GraphqlParamTypes(String)
  inboxItem(@Args('id', { type: () => ID }) id: string) {
    return this.api.getInboxItem({ inboxId: id });
  }

  @Query(() => [InboxItemModel])
  @GraphqlParamTypes(String)
  pendingDecisions(@Args('runId', { type: () => String, nullable: true }) runId?: string) {
    return this.api.pendingDecisions({ runId });
  }

  @Query(() => GateRiskModel)
  @GraphqlParamTypes(String)
  gateRisk(@Args('id', { type: () => ID }) id: string) {
    return this.api.gateRisk({ inboxId: id });
  }
}
