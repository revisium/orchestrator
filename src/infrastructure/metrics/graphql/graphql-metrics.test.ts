import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationTypeNode } from 'graphql';
import {
  GraphqlOperationMetrics,
  MAX_GRAPHQL_OPERATION_LABELS,
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

test('GraphqlOperationMetrics bounds client-controlled operation label cardinality', () => {
  const metrics = new GraphqlOperationMetrics();
  for (let i = 0; i < MAX_GRAPHQL_OPERATION_LABELS - 1; i += 1) {
    metrics.record({ operationName: `Query${i}`, operationType: OperationTypeNode.QUERY, durationMs: 1, errored: false });
  }
  metrics.record({ operationName: 'OverflowQuery', operationType: OperationTypeNode.QUERY, durationMs: 5, errored: false });
  metrics.record({ operationName: 'AnotherNewLabel', operationType: OperationTypeNode.MUTATION, durationMs: 7, errored: true });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.length, MAX_GRAPHQL_OPERATION_LABELS);
  assert.equal(snapshot.find((record) => record.operationName === 'OverflowQuery'), undefined);
  assert.deepEqual(snapshot.find((record) => record.operationName === 'other' && record.operationType === 'unknown'), {
    operationName: 'other',
    operationType: 'unknown',
    count: 2,
    errorCount: 1,
    totalDurationMs: 12,
    maxDurationMs: 7,
  });
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

  plugin.onParams?.({
    params: { operationName: 'WithErrors', query: 'query WithErrors { missing }' },
    paramsHandler: () => ({ errors: [new Error('field missing')] }),
    setParamsHandler(next: (payload: unknown) => Promise<unknown>) {
      handler = () => next({
        params: { operationName: 'WithErrors', query: 'query WithErrors { missing }' },
        request: new Request('http://127.0.0.1/graphql'),
        context: {} as never,
      });
    },
  } as never);

  await handler();
  assert.equal(metrics.snapshot().find((record) => record.operationName === 'WithErrors')?.errorCount, 1);
});
