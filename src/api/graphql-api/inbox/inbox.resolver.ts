import { Inject } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InboxApiService } from '../../../features/inbox/inbox-api.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { AnswerQuestionInput } from './inputs/answer-question.input.js';
import { GateDecisionInput } from './inputs/gate-decision.input.js';
import { ListInboxInput } from './inputs/list-inbox.input.js';
import { ResolveGateInput } from './inputs/resolve-gate.input.js';
import { ResolveInboxItemInput } from './inputs/resolve-inbox-item.input.js';
import { GateRiskModel } from './model/gate-risk.model.js';
import { InboxConnection } from './model/inbox-connection.model.js';
import { InboxItemModel } from './model/inbox-item.model.js';
import { InboxResolutionModel } from './model/inbox-resolution.model.js';

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

  @Mutation(() => InboxResolutionModel)
  @GraphqlParamTypes(GateDecisionInput)
  approveGate(@Args('data', { type: () => GateDecisionInput }) data: GateDecisionInput) {
    return this.api.approveGate(data);
  }

  @Mutation(() => InboxResolutionModel)
  @GraphqlParamTypes(GateDecisionInput)
  rejectGate(@Args('data', { type: () => GateDecisionInput }) data: GateDecisionInput) {
    return this.api.rejectGate(data);
  }

  @Mutation(() => InboxResolutionModel)
  @GraphqlParamTypes(ResolveGateInput)
  resolveGate(@Args('data', { type: () => ResolveGateInput }) data: ResolveGateInput) {
    return this.api.resolveGate(data);
  }

  @Mutation(() => InboxResolutionModel)
  @GraphqlParamTypes(AnswerQuestionInput)
  answerQuestion(@Args('data', { type: () => AnswerQuestionInput }) data: AnswerQuestionInput) {
    return this.api.answerQuestion(data);
  }

  @Mutation(() => InboxResolutionModel)
  @GraphqlParamTypes(ResolveInboxItemInput)
  resolveInboxItem(@Args('data', { type: () => ResolveInboxItemInput }) data: ResolveInboxItemInput) {
    return this.api.resolveInboxItem(data);
  }
}
