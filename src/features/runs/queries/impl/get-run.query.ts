export type GetRunQueryData = {
  runId: string;
  includeEvents?: boolean;
};

export class GetRunQuery {
  constructor(readonly data: GetRunQueryData) {}
}
