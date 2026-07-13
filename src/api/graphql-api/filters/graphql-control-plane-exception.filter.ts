import { ArgumentsHost, Catch } from '@nestjs/common';
import { GqlContextType, GqlExceptionFilter } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { ControlPlaneError } from '../../../control-plane/errors.js';

@Catch(ControlPlaneError)
export class GraphQLControlPlaneExceptionFilter implements GqlExceptionFilter {
  catch(exception: ControlPlaneError, host: ArgumentsHost): never {
    if (host.getType<GqlContextType>() !== 'graphql') {
      throw exception;
    }

    const details = isRecord(exception.details) ? exception.details : undefined;
    throw new GraphQLError(exception.message, {
      extensions: {
        code: exception.code,
        ...(details ? {
          details: {
            ...(typeof details.code === 'string' ? { code: details.code } : {}),
            ...(typeof details.path === 'string' ? { path: details.path } : {}),
          },
        } : {}),
      },
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
