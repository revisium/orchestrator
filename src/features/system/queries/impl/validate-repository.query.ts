export type ValidateRepositoryQueryData = {
  repo: string;
};

export class ValidateRepositoryQuery {
  constructor(readonly data: ValidateRepositoryQueryData) {}
}
