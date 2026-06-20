export type ListInboxQueryData = {
  status?: string;
  runId?: string;
  first?: number;
  after?: string;
};

export class ListInboxQuery {
  constructor(readonly data: ListInboxQueryData) {}
}
