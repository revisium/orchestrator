export type ListRunsQueryData = {
  status?: string;
  first?: number;
  after?: string;
};

export class ListRunsQuery {
  constructor(readonly data: ListRunsQueryData) {}
}
