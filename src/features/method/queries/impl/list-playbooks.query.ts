export type ListPlaybooksQueryData = {
  first?: number;
  after?: string;
};

export class ListPlaybooksQuery {
  constructor(readonly data: ListPlaybooksQueryData) {}
}
