import { YogaDriver, YogaDriverConfig } from '@graphql-yoga/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { InboxApiModule } from '../../features/inbox/inbox-api.module.js';
import { MethodApiModule } from '../../features/method/method-api.module.js';
import { PrApiModule } from '../../features/pr/pr-api.module.js';
import { RunsApiModule } from '../../features/runs/runs-api.module.js';
import { SystemApiModule } from '../../features/system/system-api.module.js';
import { GraphQLValidationExceptionFilter } from './filters/graphql-validation-exception.filter.js';
import { PubSubModule } from './graphql-ws/pubsub.module.js';
import { InboxResolver } from './inbox/inbox.resolver.js';
import { InboxSubscriptionResolver } from './inbox/inbox-subscription.resolver.js';
import { MethodResolver } from './method/method.resolver.js';
import { PrResolver } from './pr/pr.resolver.js';
import { registerGraphqlEnums } from './registerGraphqlEnums.js';
import { RunDigestResolver } from './runs/run-digest.resolver.js';
import { RunEventsResolver } from './runs/run-events.resolver.js';
import { RunProgressResolver } from './runs/run-progress.resolver.js';
import { RunsResolver } from './runs/runs.resolver.js';
import { RunsSubscriptionResolver } from './runs/runs-subscription.resolver.js';
import { SystemResolver } from './system/system.resolver.js';

@Module({
  imports: [
    InboxApiModule,
    MethodApiModule,
    PrApiModule,
    PubSubModule,
    RunsApiModule,
    SystemApiModule,
    GraphQLModule.forRootAsync<YogaDriverConfig>({
      driver: YogaDriver,
      useFactory: () => ({
        path: '/graphql',
        autoSchemaFile: true,
        sortSchema: true,
        introspection: true,
        resolvers: { DateTime: DateTimeResolver, JSON: JSONResolver },
        resolverValidationOptions: {
          requireResolversToMatchSchema: 'ignore',
        },
        maskedErrors: process.env.NODE_ENV !== 'development',
      }),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: GraphQLValidationExceptionFilter },
    InboxResolver,
    InboxSubscriptionResolver,
    MethodResolver,
    PrResolver,
    RunDigestResolver,
    RunEventsResolver,
    RunProgressResolver,
    RunsResolver,
    RunsSubscriptionResolver,
    SystemResolver,
  ],
})
export class GraphqlApiModule {}

registerGraphqlEnums();
