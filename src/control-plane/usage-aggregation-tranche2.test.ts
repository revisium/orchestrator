import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReportedUsage } from './usage-aggregation.js';

test('usage aggregation keeps a dimension null until a runner reports it, then sums reported values', () => {
  assert.deepEqual(aggregateReportedUsage([]), {
    inputTokens: null,
    outputTokens: null,
    costAmount: null,
  });

  assert.deepEqual(aggregateReportedUsage([
    { inputTokens: 0, outputTokens: null, costAmount: null },
    { inputTokens: null, outputTokens: 4, costAmount: 0 },
    { inputTokens: 3, outputTokens: 6, costAmount: 0.25 },
  ]), {
    inputTokens: 3,
    outputTokens: 10,
    costAmount: 0.25,
  });
});
