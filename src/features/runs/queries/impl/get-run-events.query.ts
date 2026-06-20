export type GetRunEventsQueryData = {
  runId: string;
  type?: string;
  first?: number;
  after?: string;
};

export class GetRunEventsQuery {
  constructor(readonly data: GetRunEventsQueryData) {}
}
