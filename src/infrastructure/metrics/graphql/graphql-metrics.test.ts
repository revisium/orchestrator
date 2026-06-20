import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationTypeNode } from 'graphql';
import {
  GraphqlOperationMetrics,
  createGraphqlMetricsPlugin,
  identifyGraphqlOperation,
} from './graphql-metrics.js';

test('identifyGraphqlOperation labels named operations', () => {
  assert.deepEqual(
    identifyGraphqlOperation({
      operationName: 'GetStatus',
      query: 'query GetStatus { status { ok } }',
    }),
    { operationName: 'GetStatus', operationType: 'query' },
  );
});

test('identifyGraphqlOperation labels anonymous or invalid operations without throwing', () => {
  assert.deepEqual(
    identifyGraphqlOperation({ query: '{ status { ok } }' }),
    { operationName: 'anonymous', operationType: 'query' },
  );
  assert.deepEqual(
    identifyGraphqlOperation({ operationName: 'Broken', query: 'query {' }),
    { operationName: 'Broken', operationType: 'unknown' },
  );
});

test('GraphqlOperationMetrics records operation count, errors, and duration', () => {
  const metrics = new GraphqlOperationMetrics();
  metrics.record({ operationName: 'CreateRun', operationType: OperationTypeNode.MUTATION, durationMs: 12, errored: false });
  metrics.record({ operationName: 'CreateRun', operationType: OperationTypeNode.MUTATION, durationMs: 18, errored: true });

  assert.deepEqual(metrics.snapshot(), [
    {
      operationName: 'CreateRun',
      operationType: 'mutation',
      count: 2,
      errorCount: 1,
      totalDurationMs: 30,
      maxDurationMs: 18,
    },
  ]);
});

test('createGraphqlMetricsPlugin wraps paramsHandler and records success and thrown errors', async () => {
  const metrics = new GraphqlOperationMetrics();
  let tick = 10;
  const plugin = createGraphqlMetricsPlugin(metrics, () => {
    tick += 5;
    return tick;
  });

  let handler: () => Promise<unknown> = async () => ({ data: { ok: true } });
  plugin.onParams?.({
    params: { operationName: 'Status', query: 'query Status { status { ok } }' },
    paramsHandler: handler,
    setParamsHandler(next: (payload: unknown) => Promise<unknown>) {
      handler = () => next({
        params: { operationName: 'Status', query: 'query Status { status { ok } }' },
        request: new Request('http://127.0.0.1/graphql'),
        context: {} as never,
      });
    },
  } as never);

  await handler();
  assert.deepEqual(metrics.snapshot()[0], {
    operationName: 'Status',
    operationType: 'query',
    count: 1,
    errorCount: 0,
    totalDurationMs: 5,
    maxDurationMs: 5,
  });

  plugin.onParams?.({
    params: { operationName: 'Broken', query: 'query Broken { missing }' },
    paramsHandler: () => {
      throw new Error('boom');
    },
    setParamsHandler(next: (payload: unknown) => Promise<unknown>) {
      handler = () => next({
        params: { operationName: 'Broken', query: 'query Broken { missing }' },
        request: new Request('http://127.0.0.1/graphql'),
        context: {} as never,
      });
    },
  } as never);

  await assert.rejects(() => handler(), /boom/);
  assert.equal(metrics.snapshot().find((record) => record.operationName === 'Broken')?.errorCount, 1);
});
