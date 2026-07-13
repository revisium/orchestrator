export type ReportedUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  costAmount: number | null;
};

function sumReported(values: readonly (number | null | undefined)[]): number | null {
  const reported = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return reported.length === 0 ? null : reported.reduce((sum, value) => sum + value, 0);
}

export function aggregateReportedUsage(records: readonly Partial<ReportedUsage>[]): ReportedUsage {
  return {
    inputTokens: sumReported(records.map((record) => record.inputTokens)),
    outputTokens: sumReported(records.map((record) => record.outputTokens)),
    costAmount: sumReported(records.map((record) => record.costAmount)),
  };
}
