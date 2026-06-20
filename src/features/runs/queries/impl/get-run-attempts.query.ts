export type GetRunAttemptsQueryData = {
  runId: string;
  first?: number;
  after?: string;
};

export class GetRunAttemptsQuery {
  constructor(readonly data: GetRunAttemptsQueryData) {}
}
