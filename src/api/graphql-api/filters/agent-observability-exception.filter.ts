import { ArgumentsHost, Catch } from '@nestjs/common';
import { GqlContextType, GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { AgentObservabilityError } from '../../../observability/types.js';

@Catch(AgentObservabilityError)
export class AgentObservabilityExceptionFilter implements GqlExceptionFilter {
  catch(exception: AgentObservabilityError, host: ArgumentsHost): never {
    if (host.getType<GqlContextType>() !== 'graphql') {
      throw exception;
    }

    throw new GraphQLError(exception.message, {
      extensions: { code: exception.code },
    });
  }
}
