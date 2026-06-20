export type GetPendingDecisionsQueryData = {
  runId?: string;
};

export class GetPendingDecisionsQuery {
  constructor(readonly data: GetPendingDecisionsQueryData) {}
}
