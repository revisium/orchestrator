export type GetRunWorkflowQueryData = {
  runId: string;
};

export class GetRunWorkflowQuery {
  constructor(readonly data: GetRunWorkflowQueryData) {}
}
