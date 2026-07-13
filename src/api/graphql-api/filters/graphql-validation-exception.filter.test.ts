import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgumentsHost, BadRequestException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { ControlPlaneError } from '../../../control-plane/errors.js';
import { GraphQLControlPlaneExceptionFilter } from './graphql-control-plane-exception.filter.js';
import { GraphQLValidationExceptionFilter } from './graphql-validation-exception.filter.js';

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

test('GraphQLValidationExceptionFilter maps array validation messages into a GraphQLError', () => {
  const filter = new GraphQLValidationExceptionFilter();
  const exception = new BadRequestException({ message: ['first', 'second'] });

  assert.throws(
    () => filter.catch(exception, gqlHost()),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, 'first, second');
      assert.equal(error.extensions.code, 'BAD_REQUEST');
      return true;
    },
  );
});

test('GraphQLValidationExceptionFilter preserves structured error extensions', () => {
  const filter = new GraphQLValidationExceptionFilter();
  const details = { field: 'title' };
  const context = { operation: 'status' };
  const exception = new BadRequestException({
    code: 'VALIDATION_FAILURE',
    message: 'Invalid input',
    details,
    context,
  });

  assert.throws(
    () => filter.catch(exception, gqlHost()),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, 'Invalid input');
      assert.equal(error.extensions.code, 'VALIDATION_FAILURE');
      assert.deepEqual(error.extensions.details, details);
      assert.deepEqual(error.extensions.context, context);
      return true;
    },
  );
});

test('GraphQLValidationExceptionFilter rethrows non-GraphQL bad requests unchanged', () => {
  const filter = new GraphQLValidationExceptionFilter();
  const exception = new BadRequestException('No GraphQL transport');

  assert.throws(() => filter.catch(exception, httpHost()), exception);
});

test('GraphQLControlPlaneExceptionFilter preserves stable route code and path', () => {
  const filter = new GraphQLControlPlaneExceptionFilter();
  const exception = new ControlPlaneError('VALIDATION_FAILURE', 'profile selector is invalid', {
    details: { code: 'profile_selector_invalid', path: '/profileId' },
  });

  assert.throws(
    () => filter.catch(exception, gqlHost()),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.message, 'profile selector is invalid');
      assert.equal(error.extensions.code, 'VALIDATION_FAILURE');
      assert.deepEqual(error.extensions.details, { code: 'profile_selector_invalid', path: '/profileId' });
      return true;
    },
  );
});

test('GraphQLControlPlaneExceptionFilter preserves runner mismatch code without raw details', () => {
  const filter = new GraphQLControlPlaneExceptionFilter();
  const exception = new ControlPlaneError('VALIDATION_FAILURE', 'provider is not accepted', {
    details: { code: 'runner_provider_mismatch', path: '/bindings/slots/role:developer/provider', secret: 'must-not-leak' },
  });

  assert.throws(
    () => filter.catch(exception, gqlHost()),
    (error: unknown) => {
      assert.ok(error instanceof GraphQLError);
      assert.equal(error.extensions.code, 'VALIDATION_FAILURE');
      assert.deepEqual(error.extensions.details, {
        code: 'runner_provider_mismatch',
        path: '/bindings/slots/role:developer/provider',
      });
      assert.equal(JSON.stringify(error.extensions).includes('must-not-leak'), false);
      return true;
    },
  );
});
