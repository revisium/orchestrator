export type GetRunProgressQueryData = {
  runId: string;
};

export class GetRunProgressQuery {
  constructor(readonly data: GetRunProgressQueryData) {}
}
