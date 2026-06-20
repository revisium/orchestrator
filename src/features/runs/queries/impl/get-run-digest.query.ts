export type GetRunDigestQueryData = {
  runId: string;
};

export class GetRunDigestQuery {
  constructor(readonly data: GetRunDigestQueryData) {}
}
