export type GetAgentActivityQueryData = {
  runId: string;
};

export class GetAgentActivityQuery {
  constructor(readonly data: GetAgentActivityQueryData) {}
}
