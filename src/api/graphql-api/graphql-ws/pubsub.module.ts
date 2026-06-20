import { Global, Module } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { RunsApiModule } from '../../../features/runs/runs-api.module.js';
import { APP_PUB_SUB } from './constants.js';
import { ControlPlaneSubscriptionBridge } from './subscription-bridge.service.js';
import { RunProgressSubscriptionPoller } from './run-progress-subscription-poller.service.js';

@Global()
@Module({
  imports: [RunsApiModule],
  providers: [
    // Local-first production choice. Swap this provider to graphql-redis-subscriptions for multi-instance hosts.
    { provide: APP_PUB_SUB, useFactory: () => new PubSub() },
    ControlPlaneSubscriptionBridge,
    RunProgressSubscriptionPoller,
  ],
  exports: [APP_PUB_SUB],
})
export class PubSubModule {}
