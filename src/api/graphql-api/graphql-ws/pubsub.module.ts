import { Global, Module } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { RunsApiModule } from '../../../features/runs/runs-api.module.js';
import { TaskControlPlaneModule } from '../../../task-control-plane/task-control-plane.module.js';
import { AgentObservabilitySubscriptionBridge } from './agent-observability-subscription-bridge.service.js';
import { APP_PUB_SUB } from './constants.js';
import { ControlPlaneSubscriptionBridge } from './subscription-bridge.service.js';
import { RunProgressSubscriptionPoller } from './run-progress-subscription-poller.service.js';

@Global()
@Module({
  imports: [RunsApiModule, TaskControlPlaneModule],
  providers: [
    { provide: APP_PUB_SUB, useFactory: () => new PubSub() },
    AgentObservabilitySubscriptionBridge,
    ControlPlaneSubscriptionBridge,
    RunProgressSubscriptionPoller,
  ],
  exports: [APP_PUB_SUB, AgentObservabilitySubscriptionBridge],
})
export class PubSubModule {}
