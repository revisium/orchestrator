import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { GqlContextType, GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';

type BadRequestResponse = {
  code?: string;
  context?: unknown;
  details?: unknown;
  message?: string | string[];
};

@Catch(BadRequestException)
export class GraphQLValidationExceptionFilter implements GqlExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): never {
    if (host.getType<GqlContextType>() !== 'graphql') {
      throw exception;
    }

    const response = exception.getResponse() as BadRequestResponse;
    throw new GraphQLError(this.extractMessage(response, exception), {
      extensions: {
        code: response.code ?? 'BAD_REQUEST',
        details: response.details,
        context: response.context,
      },
    });
  }

  private extractMessage(response: BadRequestResponse, exception: BadRequestException): string {
    const message = response.message;
    if (Array.isArray(message)) return message.join(', ');
    if (typeof message === 'string') return message;
    return exception.message;
  }
}
