export type GetRepositoryContextQueryData = {
  repo: string;
};

export class GetRepositoryContextQuery {
  constructor(readonly data: GetRepositoryContextQueryData) {}
}
