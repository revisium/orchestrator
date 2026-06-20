import { YogaDriver, YogaDriverConfig } from '@graphql-yoga/nestjs';
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { DateTimeResolver, JSONResolver } from 'graphql-scalars';
import { GraphQLValidationExceptionFilter } from './filters/graphql-validation-exception.filter.js';
import { registerGraphqlEnums } from './registerGraphqlEnums.js';

@Module({
  imports: [
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
        maskedErrors: false,
      }),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: GraphQLValidationExceptionFilter },
  ],
})
export class GraphqlApiModule {}

registerGraphqlEnums();
