import { Inject } from '@nestjs/common';
import { Args, ID, Subscription } from '@nestjs/graphql';
import { PubSub } from 'graphql-subscriptions';
import { AgentObservabilitySubscriptionBridge } from '../graphql-ws/agent-observability-subscription-bridge.service.js';
import { GraphqlParamTypes } from '../share/graphql-param-types.js';
import { RunSubscriptionInput } from '../share/inputs/run-subscription.input.js';
import {
  APP_PUB_SUB,
  RUN_AGENT_ACTIVITY_UPDATED_TOPIC,
  RUN_AGENT_OUTPUT_APPENDED_TOPIC,
  RUN_COST_RECORDED_TOPIC,
  RUN_EVENT_APPENDED_TOPIC,
  RUN_PROGRESS_UPDATED_TOPIC,
  RUN_UPDATED_TOPIC,
  RUN_WORKFLOW_UPDATED_TOPIC,
} from '../graphql-ws/constants.js';
import { AgentOutputEventModel, AgentRunActivityModel } from './model/agent-activity.model.js';
import { RunCostModel } from './model/run-cost.model.js';
import { RunEventModel } from './model/run-event.model.js';
import { RunProgressModel } from './model/run-progress.model.js';
import { RunModel } from './model/run.model.js';
import { RunWorkflowModel } from './model/run-workflow.model.js';

function runFilter(payload: { runId?: string }, variables: { data?: RunSubscriptionInput }) {
  return !variables.data?.runId || payload.runId === variables.data.runId;
}

export function exactRunFilter(payload: { runId?: string }, variables: { runId?: string }) {
  return Boolean(variables.runId) && payload.runId === variables.runId;
}

export class RunsSubscriptionResolver {
  constructor(
    @Inject(APP_PUB_SUB) private readonly pubSub: PubSub,
    @Inject(AgentObservabilitySubscriptionBridge)
    private readonly agentObservabilityBridge: AgentObservabilitySubscriptionBridge,
  ) {}

  @Subscription(() => RunModel, { name: RUN_UPDATED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunUpdated(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_UPDATED_TOPIC);
  }

  @Subscription(() => RunWorkflowModel, { name: RUN_WORKFLOW_UPDATED_TOPIC, filter: runFilter })
  @GraphqlParamTypes(RunSubscriptionInput)
  subscribeToRunWorkflowUpdated(@Args('data', { type: () => RunSubscriptionInput, nullable: true }) _data?: RunSubscriptionInput) {
    return this.pubSub.asyncIterableIterator(RUN_WORKFLOW_UPDATED_TOPIC);
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

  @Subscription(() => AgentRunActivityModel, { name: RUN_AGENT_ACTIVITY_UPDATED_TOPIC, filter: exactRunFilter })
  @GraphqlParamTypes(String)
  subscribeToRunAgentActivityUpdated(@Args('runId', { type: () => ID }) runId: string) {
    return this.agentObservabilityBridge.subscribeToActivity(runId);
  }

  @Subscription(() => AgentOutputEventModel, { name: RUN_AGENT_OUTPUT_APPENDED_TOPIC, filter: exactRunFilter })
  @GraphqlParamTypes(String)
  subscribeToRunAgentOutputAppended(@Args('runId', { type: () => ID }) runId: string) {
    return this.agentObservabilityBridge.subscribeToOutput(runId);
  }
}
