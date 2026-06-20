import { getOperationAST, parse, type ExecutionResult, type OperationTypeNode } from 'graphql';
import type { GraphQLParams, Plugin } from 'graphql-yoga';

export type GraphqlOperationType = OperationTypeNode | 'unknown';

export type GraphqlOperationMetricsRecord = {
  operationName: string;
  operationType: GraphqlOperationType;
  count: number;
  errorCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
};

type RecordInput = {
  operationName: string;
  operationType: GraphqlOperationType;
  durationMs: number;
  errored: boolean;
};

type OperationLabel = {
  operationName: string;
  operationType: GraphqlOperationType;
};

const ANONYMOUS_OPERATION = 'anonymous';
const OVERFLOW_OPERATION_LABEL: OperationLabel = { operationName: 'other', operationType: 'unknown' };
export const MAX_GRAPHQL_OPERATION_LABELS = 256;

function key(label: OperationLabel): string {
  return `${label.operationType}:${label.operationName}`;
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  return typeof value === 'object' && value !== null && ('data' in value || 'errors' in value);
}

function resultHasErrors(result: unknown): boolean {
  return isExecutionResult(result) && Array.isArray(result.errors) && result.errors.length > 0;
}

export function identifyGraphqlOperation(params: GraphQLParams): OperationLabel {
  const query = params.query;
  if (!query) {
    return { operationName: params.operationName ?? ANONYMOUS_OPERATION, operationType: 'unknown' };
  }

  try {
    const document = parse(query);
    const operation = getOperationAST(document, params.operationName);
    return {
      operationName: params.operationName ?? operation?.name?.value ?? ANONYMOUS_OPERATION,
      operationType: operation?.operation ?? 'unknown',
    };
  } catch {
    return { operationName: params.operationName ?? ANONYMOUS_OPERATION, operationType: 'unknown' };
  }
}

export class GraphqlOperationMetrics {
  private readonly records = new Map<string, GraphqlOperationMetricsRecord>();

  record(input: RecordInput): void {
    let label = { operationName: input.operationName, operationType: input.operationType };
    const labelKey = key(label);
    const overflowKey = key(OVERFLOW_OPERATION_LABEL);
    const leavesRoomForOverflow = this.records.size < MAX_GRAPHQL_OPERATION_LABELS - (this.records.has(overflowKey) ? 0 : 1);
    if (!this.records.has(labelKey) && !leavesRoomForOverflow) {
      label = OVERFLOW_OPERATION_LABEL;
    }
    const current = this.records.get(key(label)) ?? {
      ...label,
      count: 0,
      errorCount: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    current.count += 1;
    current.errorCount += input.errored ? 1 : 0;
    current.totalDurationMs += input.durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, input.durationMs);
    this.records.set(key(label), current);
  }

  snapshot(): GraphqlOperationMetricsRecord[] {
    return [...this.records.values()]
      .map((record) => ({ ...record }))
      .sort((a, b) => `${a.operationType}:${a.operationName}`.localeCompare(`${b.operationType}:${b.operationName}`));
  }

  reset(): void {
    this.records.clear();
  }
}

export const graphqlOperationMetrics = new GraphqlOperationMetrics();

export function createGraphqlMetricsPlugin(
  metrics = graphqlOperationMetrics,
  now: () => number = () => performance.now(),
): Plugin {
  return {
    onParams({ params, paramsHandler, setParamsHandler }) {
      const operation = identifyGraphqlOperation(params);
      setParamsHandler(async (payload) => {
        const startedAt = now();
        try {
          const result = await paramsHandler(payload);
          metrics.record({
            ...operation,
            durationMs: Math.max(0, now() - startedAt),
            errored: resultHasErrors(result),
          });
          return result;
        } catch (error) {
          metrics.record({
            ...operation,
            durationMs: Math.max(0, now() - startedAt),
            errored: true,
          });
          throw error;
        }
      });
    },
  };
}
