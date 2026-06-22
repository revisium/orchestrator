export type GetAgentAttemptsQueryData = {
  runId: string;
};

export class GetAgentAttemptsQuery {
  constructor(readonly data: GetAgentAttemptsQueryData) {}
}
