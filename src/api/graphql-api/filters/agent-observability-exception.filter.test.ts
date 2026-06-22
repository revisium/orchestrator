import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArgumentsHost } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { AgentObservabilityError } from '../../../observability/types.js';
import { AgentObservabilityExceptionFilter } from './agent-observability-exception.filter.js';

function gqlHost(): ArgumentsHost {
  return {
    getType: () => 'graphql',
  } as ArgumentsHost;
}

function httpHost(): ArgumentsHost {
  return {
    getType: () => 'http',
  } as ArgumentsHost;
}

test('AgentObservabilityExceptionFilter maps application code into GraphQL extensions', () => {
  const filter = new AgentObservabilityExceptionFilter();
  const exception = new AgentObservabilityError('NO_AGENT_ATTEMPT_AVAILABLE', 'no attempt');

  assert.throws(
    () => filter.catch(exception, gqlHost()),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, 'no attempt');
      assert.equal(error.extensions.code, 'NO_AGENT_ATTEMPT_AVAILABLE');
      return true;
    },
  );
});

test('AgentObservabilityExceptionFilter rethrows non-GraphQL errors unchanged', () => {
  const filter = new AgentObservabilityExceptionFilter();
  const exception = new AgentObservabilityError('RUN_NOT_FOUND', 'missing run');

  assert.throws(() => filter.catch(exception, httpHost()), exception);
});
