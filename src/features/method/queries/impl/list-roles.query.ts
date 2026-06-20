export type ListRolesQueryData = {
  first?: number;
  after?: string;
};

export class ListRolesQuery {
  constructor(readonly data: ListRolesQueryData) {}
}
