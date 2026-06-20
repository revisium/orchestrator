export type ListPipelinesQueryData = {
  first?: number;
  after?: string;
};

export class ListPipelinesQuery {
  constructor(readonly data: ListPipelinesQueryData) {}
}
